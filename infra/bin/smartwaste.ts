#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { SmartWasteStack } from '../lib/smartwaste-stack';

const app = new cdk.App();
new SmartWasteStack(app, 'SmartWaste', {
  // us-east-1 unless your CLI profile says otherwise. A custom domain needs us-east-1 (see README).
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION ?? 'us-east-1' },
  description: 'SmartWaste: predictive waste collection on AWS (WeMakeDevs x AWS Ship It)',
});
