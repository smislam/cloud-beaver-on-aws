import * as cdk from 'aws-cdk-lib';
import { Certificate } from 'aws-cdk-lib/aws-certificatemanager';
import { OAuthScope, UserPool, UserPoolDomain } from 'aws-cdk-lib/aws-cognito';
import { InstanceClass, InstanceSize, InstanceType, Vpc } from 'aws-cdk-lib/aws-ec2';
import { Cluster, ContainerImage, Secret as ecsSecret, FargateService, FargateTaskDefinition, LogDrivers } from 'aws-cdk-lib/aws-ecs';
import { AccessPoint, FileSystem } from 'aws-cdk-lib/aws-efs';
import { ApplicationLoadBalancer, ApplicationProtocol, ApplicationTargetGroup, ListenerAction } from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import { AuthenticateCognitoAction } from 'aws-cdk-lib/aws-elasticloadbalancingv2-actions';
import { ManagedPolicy, PolicyDocument, PolicyStatement, Role, ServicePrincipal } from 'aws-cdk-lib/aws-iam';
import { RetentionDays } from 'aws-cdk-lib/aws-logs';
import { Credentials, DatabaseInstance, DatabaseInstanceEngine, DatabaseSecret, PostgresEngineVersion } from 'aws-cdk-lib/aws-rds';
import { Secret } from 'aws-cdk-lib/aws-secretsmanager';
import { StringParameter } from 'aws-cdk-lib/aws-ssm';
import { AwsCustomResource, AwsCustomResourcePolicy, PhysicalResourceId } from 'aws-cdk-lib/custom-resources';
import { Construct } from 'constructs';

export class CloudBeaverOnAwsStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const adminUsername = 'administrator';
    const databaseName = 'cbinternal';

    const vpc = new Vpc(this, 'cbeaver-vpc', { maxAzs: 2});

    const adminSecret = new Secret(this, 'cb-admin-secret', {
      secretName: 'cb-admin-secret',
      generateSecretString: {
        secretStringTemplate: JSON.stringify({ username: adminUsername }),
        generateStringKey: 'password',
        excludePunctuation: true
      }
    });
   
    const dbSecret = new DatabaseSecret(this, 'cb-db-secret', {
      username: 'dbadmin',
    });

    const dbInstance = new DatabaseInstance(this, 'pg-instance', {
      vpc,
      engine: DatabaseInstanceEngine.postgres({version: PostgresEngineVersion.VER_17}),
      instanceType: InstanceType.of(InstanceClass.BURSTABLE3, InstanceSize.SMALL),
      databaseName,
      credentials: Credentials.fromSecret(dbSecret),
      maxAllocatedStorage: 200,
      storageEncrypted: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY
    });

    const fileSystem = new FileSystem(this, 'cb-efs', {
      vpc: vpc,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      encrypted: true
    });

    const accessPoint = new AccessPoint(this, 'efs-ap', {
      fileSystem: fileSystem,
      path: '/'
    });
    accessPoint.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);

    const cluster = new Cluster(this, 'Cluster', {vpc});

    cluster.node.addDependency(fileSystem);
    cluster.node.addDependency(dbInstance);

    const volumeName = 'cb-efs-volume';

    const taskDefinition = new FargateTaskDefinition(this, 'cb-task-def', {
      cpu: 2048,
      memoryLimitMiB: 4096,
      volumes: [{
        name: volumeName,
        efsVolumeConfiguration: {
          fileSystemId: fileSystem.fileSystemId,
          authorizationConfig: {
            accessPointId: accessPoint.accessPointId,
            iam: 'ENABLED'
          },
          transitEncryption: 'ENABLED'
        }
      }],
    });

    const container = taskDefinition.addContainer('cb-app-container', {
      image: ContainerImage.fromRegistry("dbeaver/cloudbeaver:25.1.2"),
      memoryLimitMiB: 4096,
      cpu: 2048,
      portMappings: [{
        containerPort: 8978,
        hostPort: 8978
      }],
      logging: LogDrivers.awsLogs({streamPrefix: 'cb-logs', logRetention: RetentionDays.ONE_DAY}),
      environment: {
        CB_SERVER_NAME: 'My-CB-Server',
        CB_ADMIN_NAME: adminUsername,
        CLOUDBEAVER_DB_DRIVER: 'postgres-jdbc',
        CLOUDBEAVER_DB_URL: `jdbc:postgresql://${dbInstance.dbInstanceEndpointAddress}:${dbInstance.dbInstanceEndpointPort}/${databaseName}`,
        CLOUDBEAVER_DB_USER: Credentials.fromSecret(dbSecret).username,
        CLOUDBEAVER_RESTRICT_EXTERNAL_SERVICES_INVOCATION: 'true',
        CLOUDBEAVER_QM_DB_USER: Credentials.fromSecret(dbSecret).username,
        CLOUDBEAVER_QM_DB_URL: `jdbc:postgresql://${dbInstance.dbInstanceEndpointAddress}:${dbInstance.dbInstanceEndpointPort}/${databaseName}`,
      },
      secrets: {
        CLOUDBEAVER_DB_PASSWORD: ecsSecret.fromSecretsManager(dbSecret, 'password'),
        CLOUDBEAVER_QM_DB_PASSWORD: ecsSecret.fromSecretsManager(dbSecret, 'password'),
        CB_ADMIN_PASSWORD: ecsSecret.fromSecretsManager(adminSecret, 'password')
      }
    });

    container.addMountPoints({
      containerPath: '/opt/cloudbeaver/workspace',
      sourceVolume: volumeName,
      readOnly: false
    });

    const ecsService = new FargateService(this, 'service', {
      cluster,
      taskDefinition,
      desiredCount: 1
    });
    
    fileSystem.grantReadWrite(taskDefinition.taskRole);
    fileSystem.connections.allowDefaultPortFrom(ecsService);
    dbInstance.connections.allowDefaultPortFrom(ecsService);

    //Cognito Issue or ALB Issue? This was never fixed. https://github.com/aws/aws-cdk/issues/11171
    const albName = cdk.Names.uniqueResourceName(this, { maxLength: 24 }).toLowerCase();
    const alb = new ApplicationLoadBalancer(this, 'alb', {
      vpc,
      internetFacing: true,
      loadBalancerName: albName,
    });

    const cert = Certificate.fromCertificateArn(this, 'albcert', StringParameter.valueForStringParameter(this, 'cert-arn'));

    const userPool = new UserPool(this, 'cb-user-pool', {
      selfSignUpEnabled: false,
      userPoolName: 'cb-user-pool',
      standardAttributes: {
        email: {
          required: true
        }
      },
      removalPolicy: cdk.RemovalPolicy.DESTROY
    });

    const userPoolDomain = new UserPoolDomain(this, 'cb-user-pool-domain', {
      userPool: userPool,
      cognitoDomain: {
        domainPrefix: `dbeaver-${this.account.substring(0, 4)}`,
      },
    });
    userPoolDomain.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);

    const userPoolClient = userPool.addClient('cb-user-pool-client', {
      generateSecret: true,      
      oAuth: {
        flows: {
          authorizationCodeGrant: true
        },
        scopes: [ OAuthScope.OPENID ],
        callbackUrls: [ `https://${alb.loadBalancerDnsName}/oauth2/idpresponse` ]
      },
      preventUserExistenceErrors: true,
    });
    userPoolClient.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);

    const targetGroup = new ApplicationTargetGroup(this, 'cb-alb-target', {
      vpc,
      port: 8978,
      protocol: ApplicationProtocol.HTTP,
      targets: [ecsService],
      healthCheck: {
        healthyThresholdCount: 2,
        unhealthyThresholdCount: 2,
        timeout: cdk.Duration.seconds(10),
        interval: cdk.Duration.seconds(20)
      },
    })

    const listener = alb.addListener('app-listener', {
      port: 443,
      protocol: ApplicationProtocol.HTTPS,
      certificates: [cert],
      defaultAction: new AuthenticateCognitoAction({
        userPool,
        userPoolClient,
        userPoolDomain,
        sessionTimeout: cdk.Duration.minutes(30),
        next: ListenerAction.forward([targetGroup])
      })
    });

    //Let's have a Custom resource that will create a cognito User
    const cognitoUserRole = new Role(this, 'cognito-user-role', {
      assumedBy: new ServicePrincipal('lambda.amazonaws.com'),
      managedPolicies: [
        ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole'),
      ],
      inlinePolicies: {
        CognitoUserPolicy: new PolicyDocument({
          statements: [
            new PolicyStatement({
              actions: [
                'cognito-idp:AdminCreateUser',
                'cognito-idp:AdminDeleteUser',
                'cognito-idp:AdminSetUserPassword',
                'cognito-idp:AdminConfirmSignUp',
                'cognito-idp:AdminUpdateUserAttributes',
              ],
              resources: [userPool.userPoolArn],
            }),
          ],
        }),
      },
    })

    const cognitoUser = new AwsCustomResource(this, 'cognito-user', {
      onCreate: {
        service: 'CognitoIdentityServiceProvider',
        action: 'adminCreateUser',
        physicalResourceId: PhysicalResourceId.of('cb-cognito-user-create'),
        parameters: {
          UserPoolId: userPool.userPoolId,
          Username: 'tester@test.com',
          UserAttributes: [
            {
              Name: 'email',
              Value: 'tester@test.com',
            },
            {
              Name: 'email_verified',
              Value: 'true',
            },
          ],
          TemporaryPassword: 'Pass123!',
          MessageAction: 'SUPPRESS',
        },
      },
      onDelete: {
        service: 'CognitoIdentityServiceProvider',
        action: 'adminDeleteUser',
        parameters: {
          UserPoolId: userPool.userPoolId,
          Username: 'tester@test.com',
        },
      },
      role: cognitoUserRole,
      policy: AwsCustomResourcePolicy.fromSdkCalls({
        resources: AwsCustomResourcePolicy.ANY_RESOURCE,
      })
    });    

    new cdk.CfnOutput(this, 'alb-url', { value: `https://${alb.loadBalancerDnsName}`, exportName: 'loadBalancerDnsName' });
    new cdk.CfnOutput(this, 'user', { value: 'tester@test.com', exportName: 'userEmail' });

  }
}
