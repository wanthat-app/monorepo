# infra/dns

Standalone **CloudFormation** stack (`wanthat-dns`) for DNS records that live in our
**existing** Route 53 public hosted zone but outside the CDK app's lifecycle —
domain-verification and mail records (e.g. Zoho).

It references the hosted zone by id via the `HostedZoneId` parameter and **never
creates a `HostedZone`**. (The CDK `EdgeStack` separately owns the CloudFront alias
records for the apex; keeping verification/mail records here avoids coupling them to
app deploys.)

## Records

| Purpose | Type | Name | Value |
| --- | --- | --- | --- |
| Zoho domain verification | `TXT` | `@` (apex / `wanthat.app`) | `zoho-verification=zb60222279.zmverify.zoho.com` |

## Deploy

Route 53 is a global service, so the stack's region is not significant; we use
`il-central-1` to keep it with the rest of the app.

```bash
aws cloudformation deploy \
  --stack-name wanthat-dns \
  --template-file infra/dns/template.yaml \
  --parameter-overrides HostedZoneId=Z01833842M5XCPIIPFXKG DomainName=wanthat.app \
  --region il-central-1 \
  --no-fail-on-empty-changeset
```

Validate before deploying:

```bash
aws cloudformation validate-template --template-body file://infra/dns/template.yaml
```

## Notes

- **Existing apex `TXT`?** Route 53 keeps a single `RecordSet` per name+type, so if
  the zone already has an apex `TXT` (e.g. SPF), add the Zoho value to that record set
  rather than letting this stack create a second apex `TXT` (the deploy would otherwise
  fail on a conflict). Today the apex has no other `TXT`, so the stack owns it.
- Adding more verification/mail records (DKIM, SPF, MX) later = more `AWS::Route53::RecordSet`
  resources in `template.yaml`; re-run the same deploy command.
