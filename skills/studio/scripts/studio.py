#!/usr/bin/env python3
"""Small standard-library client for Studio and Agent Session HTTP/SSE."""
import argparse
import codecs
import json
import select
import socket
import sys
import time
import uuid
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import quote
from urllib.request import Request, urlopen


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--studio-url', default='http://127.0.0.1:3211')
    parser.add_argument('--agent-url', default='http://127.0.0.1:3212')
    parser.add_argument('--token-file', default=str(Path.home() / '.pinpawo/local-server-token'))
    sub = parser.add_subparsers(dest='command', required=True)
    sub.add_parser('pets')
    sub.add_parser('kanban')
    snap = sub.add_parser('snapshot')
    snap.add_argument('pet')
    snap.add_argument('--full', action='store_true')
    events = sub.add_parser('events')
    events.add_argument('pet')
    events.add_argument('--seconds', type=float, default=30)
    for name in ('dispatch', 'send'):
        command = sub.add_parser(name)
        command.add_argument('pet')
        command.add_argument('--file', required=True, help='Text for dispatch, JSON for send; - reads stdin')
    assign = sub.add_parser('assign')
    assign.add_argument('task_id')
    assign.add_argument('pet')
    assign.add_argument('--note')
    args = parser.parse_args()
    if args.command == 'events' and not 0 < args.seconds <= 60:
        parser.error('--seconds must be in (0, 60]')
    token = Path(args.token_file).read_text().strip()
    headers = {'Authorization': 'Bearer ' + token}
    body = None
    base = args.studio_url.rstrip('/')
    if args.command in ('pets', 'kanban'):
        path = '/' + args.command
    elif args.command == 'assign':
        path = '/kanban/control'
        body = {'action': 'assign', 'taskId': args.task_id, 'assigneeId': args.pet}
        if args.note:
            body['assignmentNote'] = args.note
    else:
        text = None
        if args.command in ('dispatch', 'send'):
            text = sys.stdin.read() if args.file == '-' else Path(args.file).read_text()
        if args.command == 'dispatch':
            path = '/dispatch'
            body = {'petId': args.pet, 'request': text, 'idempotencyKey': str(uuid.uuid4())}
        else:
            base = args.agent_url.rstrip('/')
            resource = 'messages' if args.command == 'send' else args.command
            path = '/agent-session/pets/' + quote(args.pet, safe='') + '/' + resource
            if args.command == 'send':
                body = json.loads(text)
    data = None if body is None else json.dumps(body).encode()
    if data is not None:
        headers['Content-Type'] = 'application/json'
    request = Request(base + path, data=data, headers=headers)
    timeout = args.seconds if args.command == 'events' else 30
    with urlopen(request, timeout=timeout) as response:
        if args.command == 'events':
            deadline = time.monotonic() + args.seconds
            decoder = codecs.getincrementaldecoder('utf-8')()
            pending = ''
            while True:
                chunk = response.read1(65536)
                if not chunk:
                    break
                pending += decoder.decode(chunk)
                while '\n' in pending:
                    line, pending = pending.split('\n', 1)
                    if line.startswith('data:'):
                        print(line[5:].strip(), flush=True)
                remaining = deadline - time.monotonic()
                if remaining <= 0 or not select.select([response], [], [], remaining)[0]:
                    break
            return
        result = json.load(response)
    if args.command == 'snapshot' and not args.full:
        session = result['snapshot']['session']
        result = {
            'queue': result.get('queue'),
            'sessionId': session.get('sessionId'),
            'activeRun': session.get('activeRun'),
            'pendingInterrupt': session.get('pendingInterrupt'),
            'currentPlan': session.get('currentPlan'),
            'recentTimeline': session.get('timeline', [])[-4:],
        }
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    try:
        main()
    except HTTPError as error:
        print(f'HTTP {error.code}: {error.read().decode()}', file=sys.stderr)
        sys.exit(1)
    except (TimeoutError, socket.timeout):
        print('Observation/request timed out; inspect snapshot before retrying commands.', file=sys.stderr)
        sys.exit(1)
    except (OSError, URLError, ValueError, KeyError) as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
