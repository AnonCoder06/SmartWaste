# SmartWaste

Predicts which bins will overflow by morning, then plans the shortest truck route that reaches the urgent ones first.

Residents photograph a bin. A cloud pipeline estimates how full it is, updates the forecast, and warns the crew if it will overflow. Every night a workflow ranks all bins by priority, fills the truck, orders the stops and puts the route on the collector's task list.

Built for the WeMakeDevs x AWS hackathon, **Ship It** track: deployed on AWS, with a URL.

## What runs on AWS

```mermaid
flowchart LR
  user([Browser]) --> cf[CloudFront]
  cf -->|/| site[(S3 site)]
  cf -->|/api/*| apigw[API Gateway<br/>JWT authorizer]
  cognito[Cognito<br/>user pool + collectors group] -.signs tokens.-> apigw
  user -.sign in.-> cognito
  apigw --> api[Lambda: api]
  api --> ddb[(DynamoDB)]
  api -->|StartSyncExecution| sfn
  api -->|presigned POST| up[(S3 uploads)]
  user -->|photo| up
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
| Data and search | DynamoDB, S3 | single table with one GSI; site bucket and photo bucket |
| Auth and policy | Cognito | self sign-up, email confirmation, `collectors` group, JWT authorizer on every route |
| The plumbing | CloudFront, EventBridge, SQS, SNS, CloudWatch, Route 53 (optional) | one front door for site and API; schedule and event bus; photo queue with dead-letter queue; alerts; dashboard and 4 alarms |
| Agents and AI | Rekognition today, SageMaker endpoint optional | Rekognition turns away photos that are not a bin. If `SAGEMAKER_ENDPOINT` is set, the analyzer asks it for the fill level first and falls back to the built-in estimator |

No servers, no VPC, no NAT. At rest it costs close to nothing.

### How the three main flows work

**A resident reports a bin.** The page asks the API for an upload slot. The API creates a pending report in DynamoDB and returns an S3 presigned POST that fixes the key, the content type and an 8 MB size cap. The browser sends the photo straight to S3. S3 notifies SQS, the analyzer Lambda picks it up, checks the photo with Rekognition, estimates the fill level, updates the bin with an optimistic version check and publishes an `OverflowRisk` event if the forecast crosses 100%. The page polls the report until it reads `done`. A photo that is not a bin is rejected with a reason and leaves the bin untouched. A photo that fails three times lands in the dead-letter queue and raises an alarm.

**The nightly plan.** EventBridge starts the Step Functions workflow at 22:00 India time. The workflow loads bins and settings, scores each bin, picks bins in priority order until the truck is full, and, only if there is anything to collect, optimises the stop order. It saves the plan, emits `PlanReady`, and a rule emails the crew. Any failed step publishes to SNS and fails the execution. The collector console runs the same workflow on demand and gets the plan back synchronously.

**Who may do what.** Every API route needs a Cognito ID token. Anyone signed in can report. Planning, settings, ticking stops, completing a collection and resetting data need the `collectors` group, checked in the Lambda.

## Deploy

The easiest route is **AWS CloudShell** (console toolbar, top right). It already has the AWS CLI, Node and Python, and it is already signed in.

```bash
# in CloudShell: upload and unzip the project, then
cd smartwaste-aws
export DEMO_PASSWORD='Pick-a-Strong-1!'      # optional: creates demo logins for judges
export ALERT_EMAIL=you@example.com            # optional: overflow and nightly-plan emails
scripts/deploy.sh
```

On your own machine you need Node 20+, Python 3.9+ and the AWS CLI configured (`aws configure`). Use Git Bash or WSL on Windows.

The script runs the tests, builds the Pillow layer for Lambda, bootstraps CDK, deploys, prints the **live URL**, and with `DEMO_PASSWORD` set it runs the smoke test against the live site. Expect 8 to 12 minutes the first time, mostly CloudFront.

After deploying:

| Task | How |
|---|---|
| Make yourself a collector | Create an account on the site, then `scripts/make-collector.sh you@example.com` and sign in again |
| Check the live site | `python3 scripts/smoke.py <url> --email demo.collector@smartwaste.example --password "$DEMO_PASSWORD" --reset` |
| Watch it | The `DashboardUrl` output opens the CloudWatch dashboard |
| Get email alerts | Confirm the SNS subscription email AWS sends to `ALERT_EMAIL` |
| Custom domain | `DOMAIN_NAME=waste.example.com HOSTED_ZONE_NAME=example.com scripts/deploy.sh` (needs a Route 53 zone, forces us-east-1) |
| Pick a region | `AWS_REGION=ap-south-1 scripts/deploy.sh`. Defaults to your CLI region, else us-east-1. A custom domain forces us-east-1 |
| Quick S3-only demo | `scripts/deploy-s3-only.sh` hosts just the front end on S3 website hosting (HTTP, offline demo, no sign-in). `--destroy` removes it |
| Remove everything | `scripts/destroy.sh` |

`DEMO_PASSWORD` is published on the sign-in dialog so judges can click in. Do not set it for anything you want to keep private, and run `destroy.sh` when judging is over.

## Run it locally with no AWS

```bash
python3 dev/server.py            # http://localhost:8787
```

The dev server serves the front end, runs the real Lambda handlers on in-memory stand-ins for DynamoDB, S3, Step Functions and Rekognition, and imitates the Cognito sign-in endpoint. Demo logins: `demo.collector@smartwaste.example` and `demo.reporter@smartwaste.example`, password `Demo-pass-1`. `python3 dev/server.py --local` serves no `config.json`, so the page falls back to its offline demo with data in the browser.

## Tests

```bash
pip install Pillow
python3 -m unittest discover -s backend/tests -p "test_*.py"     # 35 backend tests
python3 dev/e2e.py && python3 dev/e2e_edge.py                    # browser tests, needs playwright + Chromium
```

The Python model and planner are a port of `frontend/engine.js`. `test_parity.py` runs both on five scenarios and requires identical bin scores, route order, distances and capacity decisions, so the browser and the cloud never disagree.

## What is real and what is not

- **Fill estimate.** The built-in estimator measures edge density on a 64x64 grey thumbnail. It separates empty, half and overflowing bins in clean photos and is a baseline, not a trained model. Rekognition screens out non-bin photos. The SageMaker hook is wired and tested against a stub, but no model is deployed, because there are no labelled bin photos to train on. Correcting a wrong detection is one tap, and corrections replace the original report instead of stacking.
- **Forecast.** Predicted fill is current fill plus fill rate times hours to collection. Fill does not yet grow by itself between reports.
- **Data.** One demo neighbourhood of 24 bins on a street grid. Routes use Manhattan distance on that grid, not a road network.
- **Not run in the authoring sandbox.** The CDK stack was written without access to npm or PyPI, so `cdk synth` and a real deploy have not been run. The stack file parses and its API routes match the backend route table exactly. The backend runs against faithful in-memory stand-ins, which check logic and DynamoDB expression shapes but not AWS itself. `scripts/smoke.py` is the check against the real thing: run it right after the first deploy. If `cdk deploy` reports a type error, it will point at a line in `infra/lib/smartwaste-stack.ts`.
- **Sign-up email.** Cognito's built-in sender allows about 50 emails a day. Fine for a demo. For more, point the user pool at SES.

## Security notes

Photo bucket and site bucket block all public access and enforce TLS. CloudFront reaches the site bucket with origin access control. The photo bucket accepts only presigned POSTs, with a fixed key, content type and size. Uploaded photos expire after 30 days. CloudFront adds a strict Content-Security-Policy, HSTS, frame denial and nosniff. API Gateway throttles at 50 requests per second. Lambda error messages never include internals. Pending uploads expire from DynamoDB after a day.

## Demo video script (3 minutes)

The judges score idea and impact, use of AWS, design, execution, and the video. One feature that works beats five that almost do, so show the loop end to end.

| Time | Show | Say |
|---|---|---|
| 0:00 | Gateway page, hover each side | "Bins overflow because trucks go by schedule, not by need. SmartWaste predicts which bins need emptying tonight and routes the truck to them." |
| 0:20 | Reporter side, sign in, pick bin B-05, upload a photo | "A resident photographs a bin. The photo goes straight to S3 with a presigned URL." |
| 0:50 | Result card, priority jumps, then the CloudWatch dashboard | "S3 triggers SQS, a Lambda checks the photo with Rekognition, estimates the fill and updates DynamoDB. A dead-letter queue and alarms catch failures." |
| 1:20 | Collector side, run the planner | "Step Functions scores every bin, fills the truck, and only then optimises the route." |
| 1:50 | Map and route, play the truck, tick a stop | "9 of 24 bins, 5.7 km, 3.3 km shorter than visiting everything, every urgent bin covered." |
| 2:15 | Step Functions graph in the console, EventBridge rule, SNS email | "It also runs by itself every night at 22:00 and emails the crew." |
| 2:40 | Architecture diagram from this README | "All serverless, deployed with one command. Cognito controls who can plan, CloudFront serves the site and the API." |

## Submission checklist

- Student verification on AWS Builder Center (required to compete)
- Live URL from `scripts/deploy.sh` output, plus demo logins if you set `DEMO_PASSWORD`
- The 3-minute video above
- Optional: a blog post on AWS Builder Center, linked in the submission, for the extra prize

## Layout

```
frontend/   static site: index.html, styles.css, app.js (UI), api.js (Cognito + API + offline backend), engine.js (model)
backend/    Python 3.12 Lambdas in src/smartwaste, tests in tests/, in-memory AWS stand-ins in tests/fakeaws
infra/      AWS CDK app (TypeScript), one stack
scripts/    deploy.sh, destroy.sh, build-layer.sh, make-collector.sh, smoke.py
dev/        local server and browser tests
```
