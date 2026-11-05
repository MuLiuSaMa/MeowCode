# Deployment Error Codes

The CLI converts deployment-service business code `<code>` to
`SERVICE_<code>`. Match the exact CLI `error.code` before choosing a recovery action.
Use the recommended reply as the user-facing meaning and respond in the language used
by the user. Translate the reply without changing its meaning or required next action.

Do not automatically retry a mutating command unless the table explicitly allows it.
Preserve `site_id`, `deployment_id`, and `log_id` when present. Include the stable error
code in diagnostic details, but do not replace the user-facing explanation with the raw
code or service message.

| CLI error code | Meaning | Recommended user reply | Agent action |
|-|-|-|-|
| `SERVICE_993500` | The Site does not exist or is not visible to the current user. | The specified Site does not exist or is not accessible to the current account. Refresh the Site list and select another Site. | Run `sites list`. Do not reveal whether another user owns the requested ID. |
| `SERVICE_993501` | The Deployment does not exist or is not visible to the current user. | The specified Deployment does not exist or is not accessible to the current account. Refresh the Site's Deployment history and select another Deployment. | Run `deployments list --site-id <site-id>` when a validated Site ID is available. |
| `SERVICE_993502` | The Deployment list page token is invalid or expired. | The Deployment list pagination state has expired. The list will be loaded again from the first page. | Restart the read-only list request without the stale token. |
| `SERVICE_993503` | The requested deployment type is unsupported. | This deployment type is not supported. Use a static Site or a Node.js 20 service before deploying again. | Reinspect the project and stop if it does not satisfy a supported application contract. |
| `SERVICE_993504` | The idempotency key was reused for a different request. | This request conflicts with an existing operation. Check the existing Deployment result before continuing. | Query the Site or Deployment history. Do not replay the write with guessed parameters. |
| `SERVICE_993505` | The Site already has an active Deployment. | This Site already has an active Deployment. Wait for it to finish, or confirm cancellation before continuing. | Query the active Deployment. Offer cancellation only when its current stage is cancellable. |
| `SERVICE_993506` | The Deployment state does not allow the requested operation. | The current Deployment state does not allow this operation. Refresh the Deployment state before continuing. | Run `deployments get` and choose an action allowed by the refreshed state. |
| `SERVICE_993507` | The Site has no online release for the requested operation. | This Site is not online, so this operation cannot be completed. Finish a successful Deployment first. | Run `sites get`; do not retry the rejected operation unchanged. |
| `SERVICE_993508` | The Site release changed concurrently. | The Site version has changed. Refresh the Site state before continuing. | Run `sites get` and re-evaluate the requested operation against the latest release. |
| `SERVICE_993509` | The Deployment task does not exist or is not visible to the current user. | The specified Deployment task does not exist or is not accessible to the current account. Refresh the Deployment details and try the query again. | Run `deployments get`; do not infer task ownership from the error. |
| `SERVICE_993510` | An internal Deployment task callback was rejected. | The Deployment callback was rejected and requires platform investigation. Keep the request log ID for diagnosis. | Stop. Preserve `log_id`, Deployment ID, and task ID for platform diagnosis. |
| `SERVICE_993511` | The Site or deployment configuration is invalid. | The Site configuration is invalid. Check the deployment type, access policy, and resource settings before trying again. | Reinspect the submitted configuration and change only fields proven invalid by the request or logs. |
| `SERVICE_993512` | The Site is paused. | The Site is paused. Resume it before deploying again. | Ask for confirmation before running `sites resume`, unless the user already explicitly requested resume. |
| `SERVICE_993513` | No archived log exists for the requested Deployment task. | No log is available for this Deployment task. Continue diagnosis using the Deployment state and existing error details. | Use `deployments get` and available task failure fields; do not repeatedly request the missing log. |
| `SERVICE_993514` | The current account has reached its Site limit. | The Site deployment limit has been reached. Delete Sites you no longer use before creating a new Deployment. | Stop Site creation. Run `sites list`, show cleanup candidates, and delete a Site only after explicit user confirmation. Do not retry creation or choose a Site to delete automatically. |

For an unlisted `SERVICE_*` error, use the CLI `error.message` as a concise summary,
preserve `log_id`, and stop unless the structured response proves a safe read-only
recovery action.
