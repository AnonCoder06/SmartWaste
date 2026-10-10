# SmartWaste

## Website description

SmartWaste is a waste reporting and collection planning website for residents, volunteers, and field operations teams. Residents can find a bin on the map and submit a photo to estimate its fill level. Collection teams can see which bins need attention, plan an efficient route, and track completed stops. The goal is to help crews prioritize overflowing bins and avoid unnecessary pickups.

Predicts which bins will overflow by morning, then plans the shortest truck route that reaches the urgent ones first.

Residents photograph a bin. A cloud pipeline estimates how full it is, updates the forecast, and warns the crew if it will overflow. Every night a workflow ranks all bins by priority, fills the truck, orders the stops and puts the route on the collector's task list.

Built for the WeMakeDevs x AWS hackathon, **Ship It** track. The site is hosted directly in S3 over HTTPS, and its backend is deployed to AWS in `ap-south-1` without CloudFront.

## Current interface

The gateway offers two workspaces: **Report & Upload** for residents and volunteers, and **Field Operations & Dispatch** for collection teams. The selected gateway photo expands with its panel and remains as a faint background behind the workspace content. The SmartWaste logo stays centered at the top of the gateway.

In Report & Upload, users select a bin on the map, then upload a photo or choose a sample image to estimate its fill level. Map markers show the place name on hover or keyboard focus. The map and photo report are placed before the overflow and priority summaries so the main reporting actions are easy to reach.

The sample bin locations are illustrative points in a Bengaluru demo neighborhood, not real collection addresses. The AWS map uses Amazon Location; local runs use the built-in sample map unless AWS map configuration is present.

## What runs on AWS

```mermaid
flowchart LR
  user([Browser]) -->|HTTPS site| site[(Public S3 site bucket)]
  user -->|HTTPS API| apigw[Public API Gateway]
  apigw --> api[Lambda: api]
  api --> ddb[(DynamoDB)]
  api -->|StartSyncExecution| sfn
  api -->|presigned POST| up[(S3 uploads)]
  user -->|photo| up
  user -.temporary guest credentials.-> geo[Amazon Location Maps]
  up -->|ObjectCreated| sqs[SQS + DLQ]
  sqs --> an[Lambda: analyzer<br/>Pillow + Rekognition<br/>optional SageMaker]
  an --> ddb
  sched[EventBridge schedule<br/>22:00 IST] --> sfn
  subgraph sfn[Step Functions Express: nightly planner]
    direction LR
    l[Load] --> s[Score] --> sel[Select<br/>within capacity] --> any{Any<br/>stops?}
    any -->|yes| r[Optimise route] --> sv[Save plan]
    any -->|no| sv
  end
  sfn --> ddb
  an & api & sv --> bus[EventBridge bus]
  bus -->|overflow, nightly plan| sns[SNS alerts]
  cw[CloudWatch<br/>dashboard + alarms] -.watches.-> api & an & sqs & sfn
```

| Ship It category | Services used | Where |
|---|---|---|
| Serverless | Lambda, API Gateway (HTTP API), Step Functions (Express) | `api`, analyzer and planner Lambdas; nightly planner workflow |
| Data and search | DynamoDB, S3 | single table with one GSI; public static site bucket and private photo bucket |
| Access | Public API | no account or login required; both consoles and API routes are open |
| The plumbing | API Gateway, EventBridge, SQS, SNS, CloudWatch, Amazon Location Maps | direct S3 HTTPS site and API endpoints; schedule and event bus; photo queue with dead-letter queue; alerts; dashboard and 4 alarms; real basemap with bin and route overlays |
| Agents and AI | Rekognition today, SageMaker endpoint optional | Rekognition turns away photos that are not a bin. If `SAGEMAKER_ENDPOINT` is set, the analyzer asks it for the fill level first and falls back to the built-in estimator |

No servers, no VPC, no NAT, and no CloudFront. The site bucket serves public static files directly over HTTPS. Map tiles are billed by Amazon Location usage; the browser role is limited to read-only map rendering.

### How the three main flows work

**A resident reports a bin.** The page asks the API for an upload slot. The API creates a pending report in DynamoDB and returns an S3 presigned POST that fixes the key, the content type and an 8 MB size cap. The browser sends the photo straight to S3. S3 notifies SQS, the analyzer Lambda picks it up, checks the photo with Rekognition, estimates the fill level, updates the bin with an optimistic version check and publishes an `OverflowRisk` event if the forecast crosses 100%. The page polls the report until it reads `done`. A photo that is not a bin is rejected with a reason and leaves the bin untouched. A photo that fails three times lands in the dead-letter queue and raises an alarm.

**The nightly plan.** EventBridge starts the Step Functions workflow at 22:00 India time. The workflow loads bins and settings, scores each bin, picks bins in priority order until the truck is full, and, only if there is anything to collect, optimises the stop order. It saves the plan, emits `PlanReady`, and a rule emails the crew. Any failed step publishes to SNS and fails the execution. The collector console runs the same workflow on demand and gets the plan back synchronously.

**Access.** The MVP has no login or role checks. Anyone who can reach the site can report bins, upload photos, change shared planner settings, run collections and reset the shared demo data.

## Deploy

Local development and demos do not require AWS credentials. `scripts/deploy.sh` deploys the backend and publishes the cloud-connected frontend to the existing S3 site bucket. It does not create a CloudFront distribution.

Run deployment from your own computer with the AWS CLI configured for the account and region you intend to use. Node 20+ and Python 3.9+ are also required. On Windows, use WSL or Git Bash.

```bash
# from the project directory on your computer
export ALERT_EMAIL=you@example.com            # optional: overflow and nightly-plan emails
scripts/deploy.sh
```

The script builds the Pillow layer for Lambda, bootstraps CDK, deploys the stack, prints the **live URL**, and runs the smoke test. AWS CLI credentials are required; SmartWaste itself has no login. The S3 site URL opens `index.html` over HTTPS, and the frontend calls API Gateway directly.

After deploying:

| Task | How |
|---|---|
| Check the live site and backend | `python3 scripts/smoke.py <site-url> --api-base <api-base> --reset` (use the `SiteUrl` and `ApiBase` stack outputs) |
| Watch it | The `DashboardUrl` output opens the CloudWatch dashboard |
| Get email alerts | Confirm the SNS subscription email AWS sends to `ALERT_EMAIL` |
| Pick a region | `AWS_REGION=ap-south-1 scripts/deploy.sh`. Defaults to your CLI region, else us-east-1 |
| S3-only offline demo | `scripts/deploy-s3-only.sh` publishes the browser-only demo to the S3 website endpoint over HTTP |
| Remove backend stack | `scripts/destroy.sh` |
| Remove the S3 site bucket | `scripts/deploy-s3-only.sh --destroy` |

## Run it locally with no AWS

```bash
python3 dev/server.py            # http://localhost:8787
```

The dev server serves the front end and runs the real Lambda handlers against in-memory stand-ins for DynamoDB, S3, Step Functions and Rekognition. This exercises the API and photo-report flow locally without AWS credentials. The application has no login; the local API is available to anyone who can reach the development server.

For a browser-only offline demo, run:

```bash
python3 dev/server.py --local  # http://localhost:8787
```

This omits `config.json`, so the frontend uses in-browser sample data and the built-in sample map. Changes in this mode are temporary and reset when the page is reloaded. Neither local mode deploys or writes data to AWS.

## Tests

```bash
pip install Pillow
python3 -m unittest discover -s backend/tests -p "test_*.py"
python3 dev/e2e.py && python3 dev/e2e_edge.py                    # browser tests, needs playwright + Chromium
```

The Python model and planner are a port of `frontend/engine.js`. `test_parity.py` runs both on five scenarios and requires identical bin scores, route order, distances and capacity decisions, so the browser and the cloud never disagree.

## What is real and what is not

- **Fill estimate.** The built-in estimator measures edge density on a 64x64 grey thumbnail. It separates empty, half and overflowing bins in clean photos and is a baseline, not a trained model. Rekognition screens out non-bin photos. The SageMaker hook is wired and tested against a stub, but no model is deployed, because there are no labelled bin photos to train on. Correcting a wrong detection is one tap, and corrections replace the original report instead of stacking.
- **Forecast.** Predicted fill is current fill plus fill rate times hours to collection. Fill does not yet grow by itself between reports.
- **Data and map.** One demo neighbourhood of 24 bins. The browser places illustrative points over a sample area in Bengaluru on an Amazon Location basemap. Bin place names appear on marker hover or keyboard focus. The map shows the real street basemap, but the sample bin positions are not surveyed addresses. Routes use Manhattan distance on the demo grid, not road-network directions; displayed route lines connect stops directly.
- **AWS integration.** The stack is deployed in `ap-south-1`. The deployment smoke check passed the API, S3 upload and analyzer path, reporting, planner, stop tracking, and reset flows. Its synthetic photo was correctly rejected as not showing a bin; a successful analysis of a real bin photo still needs to be checked in the live UI.

## Security notes

The photo bucket blocks public access and accepts only presigned POSTs with a fixed key, content type, and size; uploaded photos expire after 30 days. The site bucket is publicly readable so browsers can load the static app directly over HTTPS from S3. API Gateway throttles at 50 requests per second. The API intentionally has no login: anyone who can reach the site can submit reports, change shared planner settings, run collections, and reset demo data. Do not store sensitive data or use this for private operations without adding access controls.

## Layout

```
frontend/   static site: index.html, styles.css, app.js (UI), api.js (API + offline backend), engine.js (model), assets/ (gateway photos)
backend/    Python 3.12 Lambdas in src/smartwaste, tests in tests/, in-memory AWS stand-ins in tests/fakeaws
infra/      AWS CDK app (TypeScript), one stack
scripts/    deploy.sh, destroy.sh, build-layer.sh, smoke.py
dev/        local server and browser tests
incoming_updates/  drop location for update ZIPs before applying their changes
```
