`app.py` is a small HTTP service and `start.sh` is supposed to start it in the background,
but the service does not come up correctly. Fix the deployment so that running `./start.sh`
starts the service in the background on port 18080, writes its PID to `app.pid`, and
`GET http://127.0.0.1:18080/health` returns `ok`. Then start it with `./start.sh` and leave it running.
Do not change how `app.py` serves `/health`.
