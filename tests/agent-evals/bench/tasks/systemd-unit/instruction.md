Write a systemd unit file at `deploy/orders.service` for the orders API so it can run on a server:

- runs `/opt/orders/bin/server --port 8080` as user and group `orders`
- working directory `/opt/orders`
- loads environment variables from `/etc/orders/env`
- starts after the network is online (and wants it)
- restarts always, waiting 5 seconds between restarts
- is enabled for `multi-user.target`

Only write the file; do not try to install or start it.
