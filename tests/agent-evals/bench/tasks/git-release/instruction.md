The current directory is a git repository on `main`. Cut release 1.2.0:
create a branch `release/1.2.0` from `main`, set `"version"` in `package.json` to `1.2.0`,
commit only that change with the message `chore: release 1.2.0`, and create an annotated tag
`v1.2.0` on that commit. Leave `main` unchanged.
