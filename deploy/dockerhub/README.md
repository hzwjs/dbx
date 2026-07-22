# DBX

DBX is a lightweight, self-hosted database client for the browser. It supports 70+ databases, including MySQL, PostgreSQL, SQLite, Redis, MongoDB, DuckDB, ClickHouse, SQL Server, Oracle, and Elasticsearch.

- Official website: https://dbxio.com
- Documentation: https://dbxio.com/en/docs/getting-started
- 中文文档: https://dbxio.com/cn/docs/getting-started
- Source code: https://github.com/t8y2/dbx

## Quick Start

Set a strong access password and start DBX:

```bash
docker run -d \
  --pull=always \
  --name dbx \
  -p 4224:4224 \
  -e DBX_PASSWORD='change-this-password' \
  -v dbx-data:/app/data \
  --restart unless-stopped \
  t8y2/dbx:latest
```

Open `http://localhost:4224` and sign in with the value of `DBX_PASSWORD`.

The image supports `linux/amd64` and `linux/arm64`.

### ARM64 offline deployment

For an internal ARM64 server, use `deploy/docker-compose.arm64.yml`, which pins
the service to `linux/arm64`. The general `docker-compose.release.yml` remains
multi-architecture and lets Docker select the host architecture. The image
includes an ARM64 JRE 21 and
the Apache RocketMQ Java agent, so startup does not download a JRE or driver.
OceanBase MySQL Mode continues to use DBX's MySQL compatibility path with
`db_type=mysql` and `driver_profile=oceanbase`; no separate OceanBase JDBC agent
is required.

The image keeps its read-only driver bundle under `/opt/dbx/agents`. On startup,
the entrypoint copies only missing files into `${DBX_AGENT_DIR}`, or into
`${DBX_DATA_DIR}/agents` when `DBX_AGENT_DIR` is unset (default
`/app/data/agents`). The copied runtime is writable for later Driver Manager
updates; a new or existing `/app/data` volume cannot hide the built-in RocketMQ
driver. The image contains the client agent only; it does not run a RocketMQ
NameServer/Broker or an OceanBase server.

## Docker Compose

```yaml
services:
  dbx:
    image: t8y2/dbx:latest
    pull_policy: always
    environment:
      DBX_PASSWORD: change-this-password
    ports:
      - "4224:4224"
    volumes:
      - dbx-data:/app/data
    restart: unless-stopped

volumes:
  dbx-data:
```

Start or update the service:

```bash
docker compose up -d --pull always
```

## Configuration

| Variable | Default | Description |
| --- | --- | --- |
| `DBX_PASSWORD` | Not set | Access password for the DBX Web login page. Set a strong value for server deployments. |
| `DBX_DISABLE_PASSWORD` | `false` | Disables login protection when set to `true`. Do not use this on an untrusted network. |
| `DBX_DATA_DIR` | `/app/data` | Directory containing the DBX database, plugins, drivers, and other persistent data. |
| `DBX_BACKUP_DIR` | `${DBX_DATA_DIR}/backups` | Server-owned directory for Web database backup SQL files. Mount it persistently if it is outside `DBX_DATA_DIR`. |
| `TZ` | Image default | Server time zone used to interpret daily and weekly Web backup schedules. |
| `DBX_PORT` | `4224` | HTTP port inside the container. |
| `DBX_PUBLIC_BASE_PATH` | `/` | URL prefix for reverse-proxy deployments, for example `/dbx`. |

Persist `/app/data` with a named volume or bind mount. Removing this data removes saved connections and other DBX application data.

Web database backup schedules and history are stored in `/app/data/web-database-backups.json`, and backup SQL files default to `/app/data/backups`. Run only one DBX Web process against a given `DBX_DATA_DIR`; the first release does not coordinate schedulers across replicas.

## Reverse Proxy

To publish DBX under a path such as `https://example.com/dbx`, set:

```yaml
environment:
  DBX_PUBLIC_BASE_PATH: /dbx
```

Configure the reverse proxy to forward the same `/dbx` prefix to port `4224` in the container.

## China Mirror

For faster pulls in mainland China, use the CNB mirror:

```text
docker.cnb.cool/dbxio.com/dbx:latest
```

## 1Panel

DBX is available from the 1Panel app store. See the official installation guide for port, password, persistence, and access instructions:

- 中文教程: https://dbxio.com/cn/docs/1panel
- English guide: https://dbxio.com/en/docs/1panel

## Tags

- `latest`: latest stable DBX release
- `<version>`: a specific DBX release
- `dev`: current development image

For production deployments, pin a version tag when you need controlled upgrades.
