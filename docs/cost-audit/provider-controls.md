# Production provider cost controls

Verified on 2026-08-10 for the Vercel organization linked by `.vercel/project.json`.
No tokens, billing contacts, or environment values are recorded here.

## Observed provider state

- Read-only `vercel api /v2/teams/<linked-org>` reported `billing.plan=hobby`,
  `billing.status=active`, and no trial.
- Read-only `vercel usage --format json` returned `Costs not found (404)`,
  consistent with the active free plan having no billable usage ledger.

## Provider-enforced ceiling and alerts

Vercel's official Blob pricing states that Blob is free for Hobby users within
the limits, that Hobby users do not pay for additional usage, and that Blob
becomes inaccessible after the limit is exceeded. Vercel also emails Hobby
users as usage limits approach.

- https://vercel.com/docs/vercel-blob/usage-and-pricing#hobby
- https://vercel.com/docs/plans/hobby#hobby-billing-cycle
- https://vercel.com/docs/notifications#notification-details

This proves a provider-enforced `$0` overage ceiling plus provider usage-limit
alerts for the only production metered provider in this audit, Vercel Blob.
Spend Management is not available or required on Hobby because there is no
paid billing cycle.

## Invalidation condition

This evidence is valid only while the linked organization remains on an active
Hobby plan without a paid trial. Any plan or trial change invalidates the gate
and requires a fresh provider-control audit before deployment.
