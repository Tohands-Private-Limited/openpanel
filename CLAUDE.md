@AGENTS.md

## ToHands fork notes (these override AGENTS.md)

- NEVER CALL FORMAT! WE'LL FORMAT IN THE FUTURE WHEN WE HAVE MERGED ALL BIG PRS!
  Do not run `bun run fix` or `npx ultracite fix`. Check with
  `npx ultracite check <files you changed>` and fix the reported lines by hand.
- Every change we carry on top of upstream is listed in `FORK-PATCHES.md`. Keep
  it current, and mark fork code inside upstream files with `FORK (ToHands)`.
- Branches: `develop` → `staging` → `main`. Never reset or force-push `develop`,
  and never amend pushed commits.
- `migrate:deploy` against production is never run by hand.
