# fwair-me

Turn any Twitter pfp into a [fwair-pfps](https://opensea.io/collection/fwair-pfps)-style
plush — a chunky chibi stuffed toy sewn from fuzzy bouclé fleece, squeezed into a clear
glass display box it barely fits in, with glossy black bead eyes.

End goal: tweet `@clawdbotatg fwair me` and get your pfp back plushified.

## Pipeline

```
node fwairify.mjs <@handle | image-path> [--out f.png] [--quality high] [--n 3] [--keep-pfp]
```

- **Handle → pfp**: X API v2 when `X_BEARER_TOKEN` is available (auto-loaded from
  `clawd-twitter/.env`), else `unavatar.io`.
- **Generation**: OpenAI `gpt-image-2` `images.edit` with the pfp as the subject plus
  3 style-reference images sampled from `example/` (gitignored — local copies of
  collection pieces, decoded from avif via sharp), `input_fidelity: high`.
- **Flat-logo guard**: a near-solid-color pfp (e.g. the Base blue square) is detected
  by channel stdev and described explicitly in the prompt, otherwise the model drifts
  into copying a style reference instead of the subject.
- **No-pfp guard**: an account on Twitter's default silhouette avatar fails loudly
  (X API path checks the `default_profile` URL; unavatar path pixel-compares against
  `assets/default-avatar.png`) instead of plushifying the gray egg.

## Cost (measured, $8/M in + $30/M out)

Defaults are **quality low + 2 style refs ≈ $0.034/image** — at tweet size it's
indistinguishable from high/3-refs ($0.24). Each style ref costs 1,024 input tokens
($0.008). Quality tiers at 3 refs: high $0.24 · medium $0.09 · low $0.04.
Comparison grids: `out/quality-compare.jpg`, `out/refs-compare.jpg`.

Secrets live in `.env` (gitignored): `OPENAI_API_KEY`.

## Verified on

| input | result |
|---|---|
| photo-style avatar (glasses, beard, bow tie) | traits carried into fabric appliqué |
| illustrated creature (Vitalik's moose) | faithful non-human plush |
| CryptoPunk pixel art | pixelated felt patches, keeps the punk look |
| flat logo (Base blue square) | squishy blue square plush with bead eyes |

Outputs land in `out/` (gitignored).

## Next

- Website + `@clawdbotatg fwair me` tweet listener (twitter plumbing lives in
  `clawd-twitter`).
