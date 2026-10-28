import assert from 'node:assert/strict';
import test from 'node:test';
import { parse } from 'shell-quote';
import { ghWriteReason } from './ghCommands';

const argv = (command: string) => parse(command) as string[];

function expectRead(commands: string[], read: boolean) {
  for (const command of commands) {
    assert.equal(ghWriteReason(argv(command)) === undefined, read, `gh ${command}`);
  }
}

test('gh reads are recognized as read-only', () => {
  expectRead([
    'pr list', 'pr view 123 --comments', 'pr diff 123', 'pr checks 123', 'pr status',
    'issue list --label bug', 'issue view 5', 'run list -w ci.yml', 'run view 1 --log-failed',
    'workflow list', 'release view v1', 'repo view owner/repo', 'search prs is:open',
    'label list', 'auth status', 'status', '--version',
    'api repos/o/r/pulls', 'api -X GET repos/o/r', 'api --method=get repos/o/r --paginate',
    'api -H "Accept: application/json" repos/o/r/issues',
  ], true);
});

test('any gh write, credential output or unknown form is not read-only', () => {
  expectRead([
    'pr create', 'pr comment 1 --body x', 'pr review 1 --approve', 'pr edit 1 --add-label x',
    'pr close 1', 'pr reopen 1', 'pr ready 1', 'pr checkout 1', 'pr checkout 1 -b local',
    'pr update-branch 1', 'issue create', 'issue comment 1 -b x',
    'issue close 1', 'label create x', 'run rerun 1', 'run cancel 1', 'workflow run ci.yml',
    'repo clone o/r', 'pr view 1 --web', 'issue list -w',

    'pr merge 1 --squash', 'repo delete o/r', 'repo edit --visibility public', 'release create v1',
    'release delete v1', 'secret set X', 'variable delete X', 'label delete x', 'issue delete 1',
    'issue transfer 1 o/other', 'run delete 1', 'auth token', 'auth login', 'auth status --show-token',
    'extension install x', 'alias set co "pr checkout"', 'browse',
    'pr checkout 1 --force', 'pr checkout -f 1', 'pr update-branch 1 --rebase',
    'api -X POST repos/o/r/issues', 'api -XDELETE repos/o/r', 'api --method PATCH repos/o/r',
    'api repos/o/r/issues -f title=x', 'api graphql -F query=@q.graphql', 'api repos/o/r --input body.json',
    '',
  ], false);
});
