# Third-party notices

Procurement Copilot is licensed under the [MIT License](LICENSE); the demo data and documentation under [CC BY 4.0](LICENSE-DATA). It depends on the open-source packages below, which are **not** part of this repository. They are installed by `npm install`, and each remains under its own license. Full license texts are included in each package under `node_modules/<package>/`.

Versions as installed on 14 Oct 2026.

## Runtime dependencies

| Package | Version | License | Project |
| --- | --- | --- | --- |
| next | 16.4.0 | MIT | https://nextjs.org |
| react, react-dom | 19.3.0 | MIT | https://react.dev |
| zod | 4.6.7 | MIT | https://zod.dev |
| openai | 7.32.0 | Apache-2.0 | https://github.com/openai/openai-node |
| @google/genai | 2.29.0 | Apache-2.0 | https://github.com/googleapis/js-genai |
| @anthropic-ai/sdk | 0.133.0 | MIT | https://github.com/anthropics/anthropic-sdk-typescript |
| xlsx (SheetJS Community Edition) | 0.20.3 | Apache-2.0 | https://sheetjs.com |
| mammoth | 1.13.0 | BSD-2-Clause | https://github.com/mwilliamson/mammoth.js |
| unpdf | 1.8.1 | MIT | https://github.com/unjs/unpdf |
| pdf-lib | 1.17.1 | MIT | https://pdf-lib.js.org |
| sharp | 0.35.5 | Apache-2.0 (see note) | https://sharp.pixelplumbing.com |
| server-only | 0.0.1 | MIT | https://react.dev |

**Note on sharp:** sharp's prebuilt binaries bundle **libvips**, which is licensed under the **LGPL-3.0-or-later**, along with its own dependencies under various permissive licenses. libvips is used unmodified, as a dynamically loaded library. See https://sharp.pixelplumbing.com/install#licensing.

## Development dependencies

These are used only for building and testing and are not shipped with the app.

| Package | Version | License |
| --- | --- | --- |
| typescript | 5.9.3 | Apache-2.0 |
| vitest | 5.0.4 | MIT |
| @types/node, @types/react, @types/react-dom | 22.20.5 / 19.3.0 | MIT |

Transitive dependencies are listed with their licenses in `package-lock.json` and in each package under `node_modules/`.

## Services

OpenAI, Google Gemini and Anthropic are external services used through their APIs under their own terms of use. No provider code or model weights are included in this repository.
