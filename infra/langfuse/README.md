# Local Langfuse Test Environment

This directory provides a local Langfuse stack for PinPawo agent tracing and LangChain/LangGraph debugging. It is intended to be the local, open-source observability surface you can use while working on the existing LangSmith-style eval and trace flows.

Langfuse is not a drop-in replacement for the `langsmith/evaluation` SDK used by the current eval scripts. The compose stack gives you local traces, scores, datasets, and experiments in Langfuse; scripts that import `langsmith/evaluation` still need either LangSmith or a later migration to Langfuse datasets/experiments.

## Services

The compose file runs Langfuse 4.4.0 in the v4-native `events_only` mode.
PinPawo's evaluation scripts emit OpenTelemetry observations and v4 experiment
attributes, and use the supported Scores and Dataset APIs. The historic
backfill runs in the background; it needs roughly three times the existing
ClickHouse data volume in temporary disk headroom.

- `langfuse-web` on `http://localhost:3000`
- `langfuse-worker` on `127.0.0.1:3030`
- Postgres on `127.0.0.1:5432`
- ClickHouse on `127.0.0.1:8123` and `127.0.0.1:9000`
- Redis on `127.0.0.1:6379`
- MinIO on `http://localhost:9090`

## Start

Install Docker Desktop first, then run from the repository root:

```sh
npm run langfuse:up
```

The first run creates `infra/langfuse/.env` with local-only generated secrets and starts the containers. Keep this file out of git; it is already covered by the repository `.gitignore`.

To intentionally regenerate the local secrets before starting, run `LANGFUSE_ENV_OVERWRITE=1 npm run langfuse:env`.

Langfuse usually needs a couple of minutes before the web container is ready:

```sh
npm run langfuse:logs
```

Open `http://localhost:3000` and sign in with the generated owner user from `infra/langfuse/.env`:

- `LANGFUSE_INIT_USER_EMAIL`
- `LANGFUSE_INIT_USER_PASSWORD`

The generated local project keys are also in `infra/langfuse/.env`:

- `LANGFUSE_PUBLIC_KEY`
- `LANGFUSE_SECRET_KEY`
- `LANGFUSE_BASE_URL`

If you change `LANGFUSE_WEB_PORT`, update `NEXTAUTH_URL` and `LANGFUSE_BASE_URL` in `infra/langfuse/.env` to use the same port.

## Stop

```sh
npm run langfuse:down
```

Data is kept in Docker volumes. To fully reset the local Langfuse instance, stop it and remove the `pinpawo-langfuse` volumes from Docker Desktop.

## Using It With LangChain

For JS/TS LangChain or LangGraph traces, use the Langfuse LangChain callback handler or OpenTelemetry span processor in the code path you want to observe. The core client-side environment variables are:

```sh
LANGFUSE_BASE_URL=http://localhost:3000
LANGFUSE_PUBLIC_KEY=<value from infra/langfuse/.env>
LANGFUSE_SECRET_KEY=<value from infra/langfuse/.env>
```

For the current repo, the existing eval scripts under `packages/pet-agent/evals/` and `services/local-agent/evals/` are LangSmith evals because they import `langsmith/evaluation`. Use this Langfuse stack for local trace inspection first; migrate those evals separately if you want the result storage and scoring to live entirely in Langfuse.

## Useful Commands

```sh
npm run langfuse:env
npm run langfuse:config
npm run langfuse:ps
npm run langfuse:logs
npm run langfuse:down
```
