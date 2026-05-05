# Contributing

Thanks for your interest. terminalcat is a personal project, shared as-is.
Maintenance is best-effort — see the `Status` line in [README.md](README.md).

## Before you open an issue

1. Re-read the relevant section of the README. Most setup questions are
   answered there.
2. Capture the basics in the issue body:
   - distro + version (`cat /etc/os-release`)
   - architecture (`uname -m`)
   - Node version (`node --version`)
   - cloudflared version (`cloudflared --version`)
   - last 40 lines of `sudo journalctl -u terminalcat --no-pager`
3. If it's a security issue, **do not file a public issue.** See
   [SECURITY.md](SECURITY.md) for the disclosure path.

## Before you open a PR

1. Run the typecheck: `pnpm typecheck` (or `pnpm exec tsc --noEmit`). PRs
   that don't typecheck won't be merged.
2. Match the existing style. If you're not sure, look at a nearby file.
3. Keep the diff small and topical. Multi-feature PRs get split.
4. Comments explain *why*, not *what*. The `what` should be readable from
   the code.
5. Don't add dependencies unless the PR is specifically about adding one.
   Each new dep is a security-review chunk and a future-burden chunk.

## Things that are explicitly out of scope

See [TODO.md](TODO.md). Items there are deferred deliberately, not
forgotten — please don't open PRs for them without first discussing in an
issue.

## License

By submitting a PR you agree your contribution is licensed under the
project's [MIT License](LICENSE).
