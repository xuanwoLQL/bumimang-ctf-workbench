# Third-Party Notices

This repository contains an application and a lightweight skill snapshot.

## Runtime dependencies

Dependencies declared in `package.json` retain their upstream licenses:

- `@agentclientprotocol/sdk`
- `@modelcontextprotocol/sdk`
- Electron and electron-builder (development only)

Run `npm ls --all` after installation for the complete dependency inventory.

## Bundled skills

`skill-builtin/skills/ctf-solver/` includes its upstream `LICENSE` file and
must retain that file when redistributed.

`skill-builtin/skills/ctf-0day/` is the local team-authored CTF/DFIR knowledge
snapshot. It is included to keep the packaged application useful on machines
without an external skill directory.

## Research references

The project architecture was informed by the public projects listed in
`docs/OPEN-SOURCE-RESEARCH.md`. Those references do not imply endorsement or a
claim that their source code is relicensed under this repository's MIT license.

## Challenge material

Writeups and small challenge artifacts are published for competition review and
education. If a competition organizer requests removal of organizer-owned
material, open an issue with the exact path and basis for the request.
