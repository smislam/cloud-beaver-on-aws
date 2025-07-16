import * as cdk from 'aws-cdk-lib';
import { Certificate } from 'aws-cdk-lib/aws-certificatemanager';
import { InstanceClass, InstanceSize, InstanceType, Vpc } from 'aws-cdk-lib/aws-ec2';
import { Cluster, ContainerImage, Secret as ecsSecret, FargateService, FargateTaskDefinition, LogDrivers } from 'aws-cdk-lib/aws-ecs';
import { AccessPoint, FileSystem } from 'aws-cdk-lib/aws-efs';
import { ApplicationLoadBalancer, ApplicationProtocol } from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import { RetentionDays } from 'aws-cdk-lib/aws-logs';
import { Credentials, DatabaseInstance, DatabaseInstanceEngine, DatabaseSecret, PostgresEngineVersion } from 'aws-cdk-lib/aws-rds';
import { StringParameter } from 'aws-cdk-lib/aws-ssm';
import { Construct } from 'constructs';

export class CloudBeaverOnAwsStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const vpc = new Vpc(this, 'cbeaver-vpc', { maxAzs: 2});
    const databaseName = 'cbinternal';
   
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
        CLOUDBEAVER_DB_DRIVER: 'postgres-jdbc',
        CLOUDBEAVER_DB_URL: `jdbc:postgresql://${dbInstance.dbInstanceEndpointAddress}:${dbInstance.dbInstanceEndpointPort}/${databaseName}`,
        CLOUDBEAVER_DB_USER: Credentials.fromSecret(dbSecret).username,
        CLOUDBEAVER_RESTRICT_EXTERNAL_SERVICES_INVOCATION: 'true',
        CLOUDBEAVER_QM_DB_USER: Credentials.fromSecret(dbSecret).username,
        CLOUDBEAVER_QM_DB_URL: `jdbc:postgresql://${dbInstance.dbInstanceEndpointAddress}:${dbInstance.dbInstanceEndpointPort}/${databaseName}`,
      },
      secrets: {
        CLOUDBEAVER_DB_PASSWORD: ecsSecret.fromSecretsManager(dbSecret, 'password'),
        CLOUDBEAVER_QM_DB_PASSWORD: ecsSecret.fromSecretsManager(dbSecret, 'password')
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

    const alb = new ApplicationLoadBalancer(this, 'alb', {
      vpc,
      internetFacing: true
    });

    const cert = Certificate.fromCertificateArn(this, 'albcert', StringParameter.valueForStringParameter(this, 'cert-arn'));

    const listener = alb.addListener('app-listener', {
      port: 443,
      protocol: ApplicationProtocol.HTTPS,
      certificates: [cert],
    });

    listener.addTargets('cb-alb-target', {
      port: 8978,
      protocol: ApplicationProtocol.HTTP,
      targets: [ecsService],
      healthCheck: {
        healthyThresholdCount: 2,
        unhealthyThresholdCount: 2,
        timeout: cdk.Duration.seconds(10),
        interval: cdk.Duration.seconds(20)
      }
    });

    new cdk.CfnOutput(this, 'alb-url', {
      value: alb.loadBalancerDnsName,
      exportName: 'loadBalancerDnsName'
    });

  }
}
