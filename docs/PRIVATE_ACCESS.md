# Private owner access

The current preview listens only on `127.0.0.1`. Local mode is appropriate on the owner's computer. The optional hosted mode requires a signed Cloudflare Access application token and one explicitly configured owner for every page and data API. It has passed isolated tests; no live Access application, tunnel or hosting account has been configured.

## Configuration

Set the following through the host's private service configuration, using actual values from the prepared Access application:

```dotenv
NODE_ENV=production
CAUCUS_AUTH_MODE=cloudflare-access
CAUCUS_PUBLIC_ORIGIN=https://pulse.example.com
CAUCUS_ACCESS_TEAM_DOMAIN=https://YOUR-TEAM.cloudflareaccess.com
CAUCUS_ACCESS_AUDIENCE=REPLACE_WITH_APPLICATION_AUDIENCE_64_HEX_CHARACTERS
CAUCUS_OWNER_EMAIL=owner@example.com
```

These are examples, not working account details. The origin must be one exact HTTPS origin with no path or credentials. Configure Access for the entire hostname and allow only the same owner's email using the chosen identity provider. Keep the Access application session at no more than 24 hours. Publish a named Cloudflare Tunnel to the app's loopback port and finish with a catch-all 404 rule. Do not expose port 4317 through the host firewall or bypass Access for API paths.

Production mode or partial public-origin configuration refuses to start without the full access configuration. The application continues listening on loopback in hosted mode; an outbound tunnel supplies public HTTPS and the signed assertion. It does not trust an email header or an unsigned forwarding header.

## Verification behavior

`src/access.js` verifies `Cf-Access-Jwt-Assertion` with the exact configured team's public keys, RS256 signature, issuer, application audience, owner email, subject and bounded session times. Token headers cannot choose a different key URL. Requests for keys are bounded, redirect-free, cached for five minutes and backed off after failure. Invalid tokens return 401; unavailable verification returns 503. Neither condition opens the archive. Key rotation and actual provider session behavior still need an end-to-end check on the chosen host.

All pages and data APIs require that verification, including requests reaching the loopback origin directly. Mutations also require the configured public Origin. Topic corrections record the verified Access subject as their reviewer. Incident review and case history currently use the single-owner workspace context; they do not claim a multi-user audit identity.

`GET /healthz` exposes only `{"ok":true}` and no archive counts, account identities, spending, credentials or source content. It proves that the process can answer, not that collection, models, storage or provider credit are healthy. Detailed readiness remains inside authenticated APIs.

The app sends `no-store`, a restrictive content-security policy, no-referrer and HTTPS transport headers in hosted mode. It limits request URL/body sizes and header/body receive times. Source text is escaped in the interface. Access tokens are verified per request and are not written to the application database or logs.

## Before hosting is considered complete

Use the actual owner login to verify the public page and API, then verify that signed-out access and a different account cannot read any archive route. Confirm that direct origin access requires a signed assertion, incorrect audiences fail, expired sessions prompt login, and key-service failure stays closed. Check every route, including source search, teaching, incidents and private X setup. Verify backups and source removal on the target disk. No synthetic test token should ever be used as a deployed secret.

Cloudflare handles login sessions and public HTTPS; the application verifies their signed result. X credentials still need private host storage and backups need their own protection. This module does not provision a domain, tunnel, host, secret manager or off-host backup.

Primary references checked September 8, 2026: [Cloudflare JWT validation](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/), [Tunnel configuration and ingress validation](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/do-more-with-tunnels/local-management/configuration-file/), and the [jose library](https://github.com/panva/jose).
