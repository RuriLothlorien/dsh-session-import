# Installing dsh-session-import

Two ways in: let DSH fetch a release asset, or install an archive you already hold.

## Online

```bash
dsh plugin install https://github.com/RuriLothlorien/dsh-session-import/releases/latest/download/dsh-session-import.tgz
```

The asset name carries no version, deliberately: `latest/download/` resolves `latest` at request time but takes the filename literally, so a versioned name would work until the next release and 404 after it. The version lives in the tag, and the release notes state it. To stay on one build, pin the tag instead of the alias — `.../releases/download/v1.0.1/dsh-session-import.tgz`.

## Offline

```bash
dsh plugin install ./dsh-session-import.tgz
```

Or unzip it somewhere permanent and point the profile at the directory instead — useful while iterating on the bundle.

## What the bundle needs

| Service | Why |
| --- | --- |
| `webServer` | serves the panel's endpoints below `/session-import` |
| `sessionPersistence` | writes and re-reads the imported session logs |
| `connection` | the browser-trust fence every panel request passes first |

DSH `>=0.2.0-rc.2 <0.3.0-0`, Node `^22.19.0 || >=24.0.0`.

`connection` is why the floor matters: a Host that predates it cannot mount this bundle, because the routes wait for that service rather than falling back to a weaker check of their own.

## Verifying the release asset

```bash
sha256sum dsh-session-import.tgz
```

Compare against the digest in the release notes. The archive should contain exactly the files listed in `package.json`'s `files` array plus the manifest itself — fourteen entries, no build output.

## After installing

The sidebar gains a **会话导入 / Session import** entry. The first panel request from a browser needs the DSH session cookie, which the URL `dsh web` prints at startup sets; opening the panel from an unrelated tab answers `401` with instructions instead of failing silently.

If the profile already listed the bundle at an older path, replace that entry rather than adding a second one — two rows would mount the routes twice.
