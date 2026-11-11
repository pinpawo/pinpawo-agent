# Local Logto quickstart for Studio

This optional preset runs Logto OSS and its own PostgreSQL database with Docker
Compose. Studio stays on the host and continues to use its existing local Host
token. Logto's database is separate from Studio storage. PostgreSQL has no
published port; Logto's core and admin ports bind to `127.0.0.1` only. The named
volume retains Logto data across container recreation and ordinary stops. This is
a local quickstart, not a production deployment.

A verified JWT is registered as a Studio `client` on first use; that is **not**
administrator or Channel membership admission. The existing Channel rules still
apply, and Studio does not check Logto scopes or organizations. This preset has
no Studio Console OIDC login UI and does not complete a multi-user login and
authorization flow. Use a separate OIDC client to obtain the access token.

## Start

Install Docker with the Compose plugin and OpenSSL. From the repository root, create
a local database secret once, then start the isolated stack:

```sh
cd infra/logto
umask 077
if [ -e .env ]; then
  echo 'Keeping existing .env'
else
  printf 'POSTGRES_PASSWORD=%s\n' "$(openssl rand -hex 32)" > .env
fi
docker compose up -d
docker compose ps
docker compose logs -f logto
```

The generated hexadecimal password is safe to embed in a PostgreSQL URL. Keep
`.env` private and backed up with the database; it is ignored by git. Do not
regenerate it for an existing volume: PostgreSQL applies this setting only when
initializing an empty data directory. Port conflicts can be resolved by adding,
for example, `LOGTO_CORE_PORT=13001`, `LOGTO_ADMIN_PORT=13002`,
`LOGTO_ENDPOINT=http://localhost:13001`, and
`LOGTO_ADMIN_ENDPOINT=http://localhost:13002` to `.env` before starting. Update
the Studio issuer and JWKS URL to match. `ENDPOINT` controls Logto's issuer;
its exact host and port must match the token and Studio configuration.

Once ready, open `http://localhost:3002` (or your configured admin port) and
complete Logto's initial administrator setup. Use `localhost` for this HTTP
quickstart: Logto's admin interface requires a browser secure context for Web
Crypto; see its [troubleshooting guide](https://docs.logto.io/logto-oss/troubleshooting-oss). This administrator is managed by
Logto, not by Studio. Create an API resource with indicator
`https://studio.local/api`, then configure an appropriate Logto application and
its redirect URIs for your separate OIDC client. Request an **access token for
that resource** using Logto's client instructions; an ID token or a token for
another audience is not a Studio API resource token. See [Logto API resources](https://docs.logto.io/authorization/global-api-resources)
and [access-token validation](https://docs.logto.io/authorization/validate-access-tokens).

Check Logto's discovery response on the host:

```sh
curl -fsS http://localhost:3001/oidc/.well-known/openid-configuration
```

Use the returned `issuer` and `jwks_uri` rather than guessing if endpoints
change. The default expected values are `http://localhost:3001/oidc` and
`http://localhost:3001/oidc/jwks`.

## Configure Studio

In the existing `<workdir>/.pinpawo/studio.json`, add the `jwt` object from
[`studio-http.example.json`](studio-http.example.json) to the existing
`@pinpawo-plugin/studio-http` entry's `options`. Keep the rest of the entry,
other plugins, and existing Studio configuration intact. The example uses the
default endpoints and the API resource indicator above; if you chose different
values, set `issuer` and `jwksUrl` from discovery and `audience` to the exact
resource indicator. Choose a unique `clientPrefix` for this issuer. Studio
permits HTTP JWKS URLs only on loopback; use HTTPS for non-loopback endpoints.
See [Studio configuration](../../docs/studio/configuration.md) and the
[HTTP authentication reference](../../docs/reference/api/studio.md#studio-clients).

Restart your Studio process using its usual launch procedure so it reads the
updated config. The local Host token remains available with `studio` scope.
For a resource access token obtained by your client, call `GET /me` on the
Studio HTTP endpoint using that token as the Bearer credential. A successful
response has `scope: "client"` and a `clientId` beginning with `logto.`; an
invalid issuer, audience, or signature is rejected. Studio clients can be
revoked independently of Logto; a previously revoked client remains rejected.
Treat access tokens as secrets. Channel membership must be managed separately.

## Restart, stop, and data

From `infra/logto`, run `docker compose restart` to restart the services, or
`docker compose down` to stop and remove the containers and network while
retaining the database volume. Run `docker compose up -d` to start again with
the same `.env` and volume. Neither action restarts Studio. Avoid `down -v`:
it removes the database and Logto identity data. Back up the database and
secret before changing versions; follow [Logto's upgrade guidance](https://docs.logto.io/logto-oss/upgrading-oss-version).

The preset follows the [Logto v1.46.0 Compose example](https://github.com/logto-io/logto/blob/v1.46.0/docker-compose.yml)
for database readiness and initial seed. Unlike that demonstration, it uses a
persistent PostgreSQL volume. For deployment beyond local use, consult the
[official deployment guide](https://docs.logto.io/logto-oss/deployment-and-configuration),
including HTTPS and proxy configuration.
