import assert from 'node:assert/strict';
import test from 'node:test';
import { parse } from 'shell-quote';
import type { CliLevel, CliVerdict } from '../cli/cliLevels';
import { classifyGhArgs } from './ghCommands';

const argv = (command: string) => parse(command) as string[];

function expectLevel(classify: (args: string[]) => CliVerdict, program: string, level: CliLevel, commands: string[]) {
  for (const command of commands) {
    assert.equal(classify(argv(command)).level, level, `${program} ${command}`);
  }
}

test('gh reads run anywhere without review', () => {
  expectLevel(classifyGhArgs, 'gh', 'read', [
    'pr list', 'pr view 123 --comments', 'pr diff 123', 'pr checks 123', 'pr status',
    'issue list --label bug', 'issue view 5', 'run list -w ci.yml', 'run view 1 --log-failed',
    'workflow list', 'release view v1', 'repo view owner/repo', 'search prs is:open',
    'label list', 'auth status', 'status', '--version',
    'api repos/o/r/pulls', 'api -X GET repos/o/r', 'api --method=get repos/o/r --paginate',
    'api -H "Accept: application/json" repos/o/r/issues',
  ]);
});

test('everyday GitHub collaboration runs without review', () => {
  expectLevel(classifyGhArgs, 'gh', 'change', [
    'pr create', 'pr comment 1 --body x', 'pr review 1 --approve', 'pr edit 1 --add-label x',
    'pr close 1', 'pr reopen 1', 'pr ready 1', 'pr checkout 1', 'issue create', 'issue comment 1 -b x',
    'issue close 1', 'label create x', 'run rerun 1', 'run cancel 1', 'workflow run ci.yml',
    'repo clone o/r', 'pr view 1 --web', 'issue list -w',
  ]);
});

test('gh operations on shared state, credentials or unknown effects are risky', () => {
  expectLevel(classifyGhArgs, 'gh', 'risky', [
    'pr merge 1 --squash', 'repo delete o/r', 'repo edit --visibility public', 'release create v1',
    'release delete v1', 'secret set X', 'variable delete X', 'label delete x', 'issue delete 1',
    'issue transfer 1 o/other', 'run delete 1', 'auth token', 'auth login', 'auth status --show-token',
    'extension install x', 'alias set co "pr checkout"', 'browse',
    'api -X POST repos/o/r/issues', 'api -XDELETE repos/o/r', 'api --method PATCH repos/o/r',
    'api repos/o/r/issues -f title=x', 'api graphql -F query=@q.graphql', 'api repos/o/r --input body.json',
    '',
  ]);
});
