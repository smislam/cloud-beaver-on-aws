#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { CloudBeaverOnAwsStack } from '../lib/cloud-beaver-on-aws-stack';

const app = new cdk.App();
new CloudBeaverOnAwsStack(app, 'CloudBeaverOnAwsStack', {
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION }
});