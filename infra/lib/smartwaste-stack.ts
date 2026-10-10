import * as fs from 'fs';
import * as path from 'path';
import { CfnOutput, Duration, Fn, RemovalPolicy, Stack, StackProps, Tags } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as apigwv2 from 'aws-cdk-lib/aws-apigatewayv2';
import { HttpLambdaIntegration } from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as cwActions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { SqsEventSource } from 'aws-cdk-lib/aws-lambda-event-sources';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as r53targets from 'aws-cdk-lib/aws-route53-targets';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import * as s3n from 'aws-cdk-lib/aws-s3-notifications';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as subs from 'aws-cdk-lib/aws-sns-subscriptions';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as sfn from 'aws-cdk-lib/aws-stepfunctions';
import * as tasks from 'aws-cdk-lib/aws-stepfunctions-tasks';
import * as triggers from 'aws-cdk-lib/triggers';

/**
 * SmartWaste on AWS. One stack, all serverless, nothing to patch.
 *
 *   Browser ──► CloudFront ──► S3 (static site)
 *                  │
 *                  └─ /api/* ──► API Gateway ──► Lambda api ──► DynamoDB
 *                                                                   │  └──► Step Functions (Express) ──► planner Lambdas ──► DynamoDB
 *                                                                   └──► S3 presigned POST
 *   Photo ──► S3 uploads ──► SQS (+DLQ) ──► Lambda analyzer (Pillow, Rekognition, optional SageMaker) ──► DynamoDB
 *   Lambda / Step Functions ──► EventBridge bus ──► SNS alerts;  EventBridge schedule ──► Step Functions (nightly)
 *   CloudWatch: dashboard, alarms, custom metrics from the Lambdas
 *
 * Optional context (cdk deploy -c key=value):
 *   alertEmail         subscribe this address to overflow and nightly-plan alerts
 *   sagemakerEndpoint  name of a SageMaker endpoint the analyzer should ask for fill levels first
 *   domainName + hostedZoneName   serve the site from your own Route 53 domain (needs us-east-1)
 */
export class SmartWasteStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);
    Tags.of(this).add('project', 'smartwaste');

    const ctx = (key: string): string | undefined => {
      const v = this.node.tryGetContext(key);
      return v === undefined || v === null || v === '' ? undefined : String(v);
    };
    const alertEmail = ctx('alertEmail');
    const sagemakerEndpoint = ctx('sagemakerEndpoint');
    const domainName = ctx('domainName');
    const hostedZoneName = ctx('hostedZoneName');

    const backendDir = path.join(__dirname, '../../backend');
    const layerDir = path.join(backendDir, 'layer');
    if (!fs.existsSync(path.join(layerDir, 'python'))) {
      throw new Error('The Pillow layer is missing. Run scripts/build-layer.sh (scripts/deploy.sh does it for you).');
    }

    // ------------------------------------------------------------------ data
    const table = new dynamodb.Table(this, 'Table', {
      partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'sk', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      timeToLiveAttribute: 'ttl',
      pointInTimeRecovery: true,
      removalPolicy: RemovalPolicy.DESTROY, // hackathon stack: `cdk destroy` leaves nothing behind
    });
    table.addGlobalSecondaryIndex({
      indexName: 'gsi1',
      partitionKey: { name: 'gsi1pk', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'gsi1sk', type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    const siteBucket = new s3.Bucket(this, 'Site', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    const uploads = new s3.Bucket(this, 'Uploads', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      lifecycleRules: [{ expiration: Duration.days(30) }],
      // Browsers POST photos straight here with a presigned policy. The policy, not the origin, is the gate:
      // it fixes the key, content type and size.
      cors: [{ allowedMethods: [s3.HttpMethods.POST], allowedOrigins: ['*'], allowedHeaders: ['*'], maxAge: 3000 }],
    });

    // The browser uses short-lived guest credentials for Amazon Location's
    // basemap APIs. Keep the role limited to rendering the default map style.
    const mapIdentityPool = new cognito.CfnIdentityPool(this, 'MapIdentityPool', {
      identityPoolName: 'smartwaste-map',
      allowUnauthenticatedIdentities: true,
    });
    const mapGuestRole = new iam.Role(this, 'MapGuestRole', {
      assumedBy: new iam.FederatedPrincipal('cognito-identity.amazonaws.com', {
        'StringEquals': { 'cognito-identity.amazonaws.com:aud': mapIdentityPool.ref },
        'ForAnyValue:StringLike': { 'cognito-identity.amazonaws.com:amr': 'unauthenticated' },
      }, 'sts:AssumeRoleWithWebIdentity'),
    });
    mapGuestRole.addToPolicy(new iam.PolicyStatement({
      actions: ['geo-maps:GetTile', 'geo-maps:GetStyleDescriptor', 'geo-maps:GetSprites', 'geo-maps:GetGlyphs'],
      resources: [`arn:${this.partition}:geo-maps:${this.region}::provider/default`],
    }));
    new cognito.CfnIdentityPoolRoleAttachment(this, 'MapIdentityPoolRoles', {
      identityPoolId: mapIdentityPool.ref,
      roles: { unauthenticated: mapGuestRole.roleArn },
    });

    // ------------------------------------------------------------------ messaging
    const alerts = new sns.Topic(this, 'Alerts', { displayName: 'SmartWaste alerts' });
    if (alertEmail) alerts.addSubscription(new subs.EmailSubscription(alertEmail));
    const bus = new events.EventBus(this, 'Bus');

    const photoDlq = new sqs.Queue(this, 'PhotoDlq', {
      retentionPeriod: Duration.days(14),
      encryption: sqs.QueueEncryption.SQS_MANAGED,
      enforceSSL: true,
    });
    const photoQueue = new sqs.Queue(this, 'PhotoQueue', {
      visibilityTimeout: Duration.seconds(180),
      encryption: sqs.QueueEncryption.SQS_MANAGED,
      enforceSSL: true,
      deadLetterQueue: { queue: photoDlq, maxReceiveCount: 3 },
    });
    uploads.addEventNotification(s3.EventType.OBJECT_CREATED, new s3n.SqsDestination(photoQueue), { prefix: 'uploads/' });

    // ------------------------------------------------------------------ lambdas (Python 3.12, no bundling needed)
    const code = lambda.Code.fromAsset(path.join(backendDir, 'src'), { exclude: ['**/__pycache__', '**/*.pyc'] });
    const baseEnv: Record<string, string> = { TABLE_NAME: table.tableName, EVENT_BUS: bus.eventBusName };
    const makeFn = (fnId: string, handler: string, opts: { env?: Record<string, string>; timeout?: number; memory?: number; layers?: lambda.ILayerVersion[] } = {}) =>
      new lambda.Function(this, fnId, {
        runtime: lambda.Runtime.PYTHON_3_12,
        architecture: lambda.Architecture.X86_64,
        code,
        handler,
        memorySize: opts.memory ?? 256,
        timeout: Duration.seconds(opts.timeout ?? 15),
        environment: { ...baseEnv, ...(opts.env ?? {}) },
        layers: opts.layers,
        tracing: lambda.Tracing.ACTIVE,
        logRetention: logs.RetentionDays.TWO_WEEKS,
      });

    const pillow = new lambda.LayerVersion(this, 'PillowLayer', {
      code: lambda.Code.fromAsset(layerDir),
      compatibleRuntimes: [lambda.Runtime.PYTHON_3_12],
      compatibleArchitectures: [lambda.Architecture.X86_64],
      description: 'Pillow, for decoding bin photos in the analyzer',
    });

    // planner steps (Step Functions tasks)
    const loadFn = makeFn('PlanLoad', 'smartwaste.planner.load');
    const scoreFn = makeFn('PlanScore', 'smartwaste.planner.score');
    const selectFn = makeFn('PlanSelect', 'smartwaste.planner.select');
    const routeFn = makeFn('PlanRoute', 'smartwaste.planner.route', { timeout: 30 });
    const saveFn = makeFn('PlanSave', 'smartwaste.planner.save');
    table.grantReadData(loadFn);
    table.grantReadWriteData(saveFn);
    bus.grantPutEventsTo(saveFn);

    // ------------------------------------------------------------------ nightly planner workflow
    const failed = new sfn.Fail(this, 'PlanFailed', { error: 'PlannerError', cause: 'A planner step failed. See the Planner log group.' });
    const notifyFailure = new tasks.SnsPublish(this, 'NotifyFailure', {
      topic: alerts,
      subject: 'SmartWaste planner failed',
      message: sfn.TaskInput.fromText('The collection planner failed. Open the SmartWaste dashboard in CloudWatch for the error.'),
      resultPath: sfn.JsonPath.DISCARD,
    });
    const onFailure = notifyFailure.next(failed);
    const step = (stepId: string, fn: lambda.IFunction) =>
      new tasks.LambdaInvoke(this, stepId, { lambdaFunction: fn, payloadResponseOnly: true, resultPath: '$' })
        .addCatch(onFailure, { resultPath: '$.error' });

    const savePlan = step('SavePlan', saveFn);
    const optimise = step('OptimiseRoute', routeFn).next(savePlan);
    const anyStops = new sfn.Choice(this, 'AnyBinsToCollect')
      .when(sfn.Condition.numberGreaterThan('$.chosenCount', 0), optimise)
      .otherwise(savePlan);
    const definition = step('LoadBins', loadFn)
      .next(step('ScoreBins', scoreFn))
      .next(step('SelectWithinCapacity', selectFn))
      .next(anyStops);

    const plannerLogs = new logs.LogGroup(this, 'PlannerLogs', { retention: logs.RetentionDays.TWO_WEEKS, removalPolicy: RemovalPolicy.DESTROY });
    const planner = new sfn.StateMachine(this, 'Planner', {
      stateMachineType: sfn.StateMachineType.EXPRESS,
      definitionBody: sfn.DefinitionBody.fromChainable(definition),
      timeout: Duration.minutes(2),
      tracingEnabled: true,
      logs: { destination: plannerLogs, level: sfn.LogLevel.ALL, includeExecutionData: false },
    });

    // ------------------------------------------------------------------ API
    const apiFn = makeFn('ApiFn', 'smartwaste.api.handler', {
      env: { UPLOAD_BUCKET: uploads.bucketName, STATE_MACHINE_ARN: planner.stateMachineArn },
    });
    table.grantReadWriteData(apiFn);
    bus.grantPutEventsTo(apiFn);
    uploads.grantPut(apiFn); // the presigned POST is signed with this role, so it needs s3:PutObject
    planner.grantStartSyncExecution(apiFn);

    const analyzerEnv: Record<string, string> = { UPLOAD_BUCKET: uploads.bucketName, REJECT_NON_BIN: 'true', MAX_RECEIVES: '3' };
    if (sagemakerEndpoint) analyzerEnv.SAGEMAKER_ENDPOINT = sagemakerEndpoint;
    const analyzer = makeFn('Analyzer', 'smartwaste.analyzer.handler', { env: analyzerEnv, timeout: 30, memory: 512, layers: [pillow] });
    table.grantReadWriteData(analyzer);
    bus.grantPutEventsTo(analyzer);
    uploads.grantRead(analyzer);
    analyzer.addToRolePolicy(new iam.PolicyStatement({ actions: ['rekognition:DetectLabels'], resources: ['*'] }));
    if (sagemakerEndpoint) {
      analyzer.addToRolePolicy(new iam.PolicyStatement({
        actions: ['sagemaker:InvokeEndpoint'],
        resources: [this.formatArn({ service: 'sagemaker', resource: 'endpoint', resourceName: sagemakerEndpoint })],
      }));
    }
    analyzer.addEventSource(new SqsEventSource(photoQueue, { batchSize: 5, maxBatchingWindow: Duration.seconds(1), reportBatchItemFailures: true }));

    const api = new apigwv2.HttpApi(this, 'HttpApi', {
      apiName: 'smartwaste-api',
      description: 'Public SmartWaste HTTP API.',
    });
    const apiIntegration = new HttpLambdaIntegration('ApiIntegration', apiFn);
    // Keep in step with ROUTES in backend/src/smartwaste/api.py
    const routes: Array<[apigwv2.HttpMethod, string]> = [
      [apigwv2.HttpMethod.GET, '/api/state'],
      [apigwv2.HttpMethod.POST, '/api/bins/{id}/uploads'],
      [apigwv2.HttpMethod.GET, '/api/reports/{id}'],
      [apigwv2.HttpMethod.POST, '/api/bins/{id}/reports'],
      [apigwv2.HttpMethod.PUT, '/api/config'],
      [apigwv2.HttpMethod.POST, '/api/plans'],
      [apigwv2.HttpMethod.POST, '/api/plans/latest/stops/{id}'],
      [apigwv2.HttpMethod.POST, '/api/plans/latest/complete'],
      [apigwv2.HttpMethod.POST, '/api/admin/reset'],
    ];
    routes.forEach(([method, routePath]) => api.addRoutes({ path: routePath, methods: [method], integration: apiIntegration }));
    const stage = api.defaultStage?.node.defaultChild as apigwv2.CfnStage | undefined;
    if (stage) stage.defaultRouteSettings = { throttlingBurstLimit: 100, throttlingRateLimit: 50 };

    // ------------------------------------------------------------------ events
    const detail = (field: string) => events.EventField.fromPath(`$.detail.${field}`);
    new events.Rule(this, 'OverflowRiskRule', {
      eventBus: bus,
      description: 'A report pushed a bin over the overflow line',
      eventPattern: { source: ['smartwaste.app'], detailType: ['OverflowRisk'] },
      targets: [new targets.SnsTopic(alerts, {
        message: events.RuleTargetInput.fromText(
          `Bin ${detail('binId')} (${detail('name')}) is forecast to reach ${detail('predictedFill')}% by morning. It is ${detail('currentFill')}% full now. Source: ${detail('source')}.`),
      })],
    });
    new events.Rule(this, 'NightlyPlanReadyRule', {
      eventBus: bus,
      description: 'Tell the crew when the scheduled plan is ready',
      eventPattern: { source: ['smartwaste.app'], detailType: ['PlanReady'], detail: { trigger: ['schedule'] } },
      targets: [new targets.SnsTopic(alerts, {
        message: events.RuleTargetInput.fromText(
          `Tonight's collection plan ${detail('planId')} is ready: ${detail('stops')} stops, ${detail('km')} km, ${detail('loadLitres')} L. Urgent bins covered: ${detail('urgentCovered')}.`),
      })],
    });
    new events.Rule(this, 'NightlySchedule', {
      description: 'Run the planner at 22:00 India time (16:30 UTC)',
      schedule: events.Schedule.cron({ minute: '30', hour: '16' }),
      targets: [new targets.SfnStateMachine(planner, { input: events.RuleTargetInput.fromObject({ trigger: 'schedule', by: 'EventBridge schedule' }) })],
    });

    // ------------------------------------------------------------------ front door
    const siteDir = path.join(__dirname, '../../frontend');
    const csp = [
      "default-src 'self'",
      "script-src 'self' https://cdn.jsdelivr.net",
      "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://cdn.jsdelivr.net",
      "font-src https://fonts.gstatic.com",
      "img-src 'self' data: blob:",
      "worker-src 'self' blob:",
      `connect-src 'self' https://cognito-identity.${this.region}.amazonaws.com https://sts.${this.region}.amazonaws.com https://maps.geo.${this.region}.amazonaws.com https://*.s3.amazonaws.com https://*.s3.${this.region}.amazonaws.com`,
      "frame-ancestors 'none'",
      "base-uri 'self'",
      "form-action 'self'",
    ].join('; ');
    const headers = new cloudfront.ResponseHeadersPolicy(this, 'SecurityHeaders', {
      securityHeadersBehavior: {
        contentSecurityPolicy: { contentSecurityPolicy: csp, override: true },
        contentTypeOptions: { override: true },
        frameOptions: { frameOption: cloudfront.HeadersFrameOption.DENY, override: true },
        referrerPolicy: { referrerPolicy: cloudfront.HeadersReferrerPolicy.STRICT_ORIGIN_WHEN_CROSS_ORIGIN, override: true },
        strictTransportSecurity: { accessControlMaxAge: Duration.days(365), includeSubdomains: true, override: true },
      },
    });

    let domainProps: { domainNames: string[]; certificate: acm.ICertificate } | undefined;
    let zone: route53.IHostedZone | undefined;
    if (domainName && hostedZoneName) {
      if (this.region !== 'us-east-1') {
        throw new Error('A custom domain needs the stack in us-east-1, because CloudFront certificates live there. Set CDK_DEFAULT_REGION=us-east-1.');
      }
      zone = route53.HostedZone.fromLookup(this, 'Zone', { domainName: hostedZoneName });
      const cert = new acm.Certificate(this, 'Cert', { domainName, validation: acm.CertificateValidation.fromDns(zone) });
      domainProps = { domainNames: [domainName], certificate: cert };
    }

    const apiHost = Fn.select(2, Fn.split('/', api.apiEndpoint));
    const cdn = new cloudfront.Distribution(this, 'Cdn', {
      comment: 'SmartWaste site and API',
      defaultRootObject: 'index.html',
      httpVersion: cloudfront.HttpVersion.HTTP2_AND_3,
      minimumProtocolVersion: cloudfront.SecurityPolicyProtocol.TLS_V1_2_2021,
      ...(domainProps ?? {}),
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(siteBucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        responseHeadersPolicy: headers,
        compress: true,
      },
      additionalBehaviors: {
        '/api/*': {
          origin: new origins.HttpOrigin(apiHost, { protocolPolicy: cloudfront.OriginProtocolPolicy.HTTPS_ONLY }),
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.HTTPS_ONLY,
          allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
          cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
          originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
          responseHeadersPolicy: headers,
        },
      },
    });
    if (zone && domainName) {
      const target = route53.RecordTarget.fromAlias(new r53targets.CloudFrontTarget(cdn));
      new route53.ARecord(this, 'AliasA', { zone, recordName: domainName, target });
      new route53.AaaaRecord(this, 'AliasAaaa', { zone, recordName: domainName, target });
    }

    const siteConfig: Record<string, unknown> = {
      mode: 'cloud',
      region: this.region,
      apiBase: '/api',
      schedule: 'every night at 22:00 IST',
      map: { identityPoolId: mapIdentityPool.ref, region: this.region, style: 'Standard' },
    };
    new s3deploy.BucketDeployment(this, 'DeploySite', {
      sources: [s3deploy.Source.asset(siteDir), s3deploy.Source.jsonData('config.json', siteConfig)],
      destinationBucket: siteBucket,
      distribution: cdn,
      distributionPaths: ['/*'],
      prune: true,
    });

    // ------------------------------------------------------------------ seed data after every deploy
    const seedFn = makeFn('Seed', 'smartwaste.seed.handler', {
      timeout: 60,
      env: {},
    });
    table.grantReadWriteData(seedFn);
    new triggers.Trigger(this, 'SeedOnDeploy', {
      handler: seedFn,
      timeout: Duration.minutes(2),
      invocationType: triggers.InvocationType.REQUEST_RESPONSE,
      // the role is listed so its inline policy exists before the first invoke
      executeAfter: [table, ...(seedFn.role ? [seedFn.role] : [])],
    });

    // ------------------------------------------------------------------ observability
    const metric = (namespace: string, metricName: string, dimensionsMap: Record<string, string> | undefined, statistic = 'Sum', label?: string) =>
      new cloudwatch.Metric({ namespace, metricName, dimensionsMap, statistic, label: label ?? metricName, period: Duration.minutes(5) });
    const apiDims = { ApiId: api.apiId };
    const apiCount = metric('AWS/ApiGateway', 'Count', apiDims, 'Sum', 'Requests');
    const api4xx = metric('AWS/ApiGateway', '4xx', apiDims, 'Sum', '4xx');
    const api5xx = metric('AWS/ApiGateway', '5xx', apiDims, 'Sum', '5xx');
    const apiP95 = metric('AWS/ApiGateway', 'Latency', apiDims, 'p95', 'p95 latency');
    const app = (name: string, label: string) => metric('SmartWaste', name, undefined, 'Sum', label);

    const dashboard = new cloudwatch.Dashboard(this, 'Dashboard', { defaultInterval: Duration.hours(3) });
    dashboard.addWidgets(
      new cloudwatch.TextWidget({ markdown: '# SmartWaste\nAPI traffic, the photo pipeline, the nightly planner, and what the system is seeing in the field.', width: 24, height: 2 }),
      new cloudwatch.GraphWidget({ title: 'API requests and errors', left: [apiCount], right: [api4xx, api5xx], width: 12 }),
      new cloudwatch.GraphWidget({ title: 'API latency (ms)', left: [apiP95], width: 12 }),
      new cloudwatch.GraphWidget({
        title: 'Photo pipeline',
        left: [photoQueue.metricApproximateNumberOfMessagesVisible({ label: 'Queued' }), photoDlq.metricApproximateNumberOfMessagesVisible({ label: 'Dead-lettered' })],
        right: [analyzer.metricInvocations({ label: 'Analyzer runs' }), analyzer.metricErrors({ label: 'Analyzer errors' })],
        width: 12,
      }),
      new cloudwatch.GraphWidget({
        title: 'Nightly planner',
        left: [planner.metricStarted({ label: 'Started' }), planner.metricSucceeded({ label: 'Succeeded' }), planner.metricFailed({ label: 'Failed' })],
        width: 12,
      }),
      new cloudwatch.GraphWidget({
        title: 'In the field',
        left: [app('ReportsApplied', 'Reports'), app('PhotosAnalyzed', 'Photos analysed'), app('PhotosRejected', 'Photos rejected'), app('OverflowRisk', 'Overflow warnings'), app('PlansCreated', 'Plans')],
        width: 24,
      }),
    );

    const notify = new cwActions.SnsAction(alerts);
    const alarm = (alarmId: string, m: cloudwatch.IMetric, threshold: number, description: string) =>
      new cloudwatch.Alarm(this, alarmId, {
        metric: m,
        threshold,
        evaluationPeriods: 1,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
        alarmDescription: description,
      }).addAlarmAction(notify);
    alarm('PhotoDlqAlarm', photoDlq.metricApproximateNumberOfMessagesVisible({ period: Duration.minutes(1) }), 1, 'A photo failed analysis three times and is in the dead-letter queue.');
    alarm('Api5xxAlarm', api5xx, 5, 'The API returned five or more server errors in five minutes.');
    alarm('AnalyzerErrorAlarm', analyzer.metricErrors({ period: Duration.minutes(5) }), 3, 'The photo analyzer is failing.');
    alarm('PlannerFailedAlarm', planner.metricFailed({ period: Duration.minutes(5) }), 1, 'The collection planner failed.');

    // ------------------------------------------------------------------ outputs
    const siteUrl = domainName ? `https://${domainName}` : `https://${cdn.distributionDomainName}`;
    new CfnOutput(this, 'SiteUrl', { value: siteUrl, description: 'Open this to use SmartWaste' });
    new CfnOutput(this, 'CloudFrontUrl', { value: `https://${cdn.distributionDomainName}` });
    new CfnOutput(this, 'TableName', { value: table.tableName });
    new CfnOutput(this, 'UploadBucket', { value: uploads.bucketName });
    new CfnOutput(this, 'MapIdentityPoolId', { value: mapIdentityPool.ref });
    new CfnOutput(this, 'PlannerArn', { value: planner.stateMachineArn });
    new CfnOutput(this, 'DashboardUrl', {
      value: `https://${this.region}.console.aws.amazon.com/cloudwatch/home?region=${this.region}#dashboards:name=${dashboard.dashboardName}`,
    });
  }
}
