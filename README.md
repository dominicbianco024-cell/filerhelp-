# FileShelf

Find the file Claude sent 200 messages ago. Open **/fileshelf** in the original Windows Claude Code session, search for a filename or extension, and save an available copy. The shelf lives inside the Code tab beside your conversation. It can read history from before installation.

## Install by asking Claude

Open a **local Windows session** in the Claude Desktop **Code** tab. Paste the following message.

> Install the FileShelf plugin for my Windows Claude Code Desktop user account from the GitHub repository `dominicbianco024-cell/filerhelp-` (https://github.com/dominicbianco024-cell/filerhelp-). Check the requirements in its README, install the plugin from its marketplace, and verify it appears in my installed plugins. Tell me how to reopen my original conversation and launch the shelf.

**From a ZIP:** Extract the entire archive to a folder you plan to keep. Open that folder in Claude Code Desktop and say:

> Install FileShelf from this folder for my Windows Claude Code Desktop account. Follow the README and verify that the plugin is enabled.

### How the installer works

- Use Claude Desktop with the local Code engine **2.1.331 or newer**. Enter `/status` in the Code tab to check. Choose the native Windows local environment. The Chat and Cowork tabs and sessions running in WSL, over SSH, or in the cloud are outside this release's scope.
- Install **Node.js 22 or newer** on the Windows PATH. This runs the included file reader, which uses only Node's standard library. A Windows machine with WinGet can install Node LTS with `winget install --id OpenJS.NodeJS.LTS -e`. Restart Desktop after installing Node so it sees the updated PATH.
- From the extracted repository folder, run `.\Install-FileShelf.ps1`. This uses the official Claude CLI if present or runs its pinned npm distribution via npx. Local installation uses this folder as the marketplace. Keep it for updates.
- With a current Claude CLI already on PATH, the direct local equivalent is `claude plugin install fileshelf --marketplace "$((Get-Location).Path)" --scope user`. The public install command is `claude plugin install fileshelf --marketplace dominicbianco024-cell/filerhelp- --scope user`. Check the result with `claude plugin list` and look for `fileshelf@fileshelf-marketplace` marked enabled.
- If the command is missing in an already-open conversation, quit and reopen Claude Desktop, resume that same conversation, then enter `/fileshelf`. The pane's command is registered at session startup.

## Find a file

1. Open the conversation where Claude delivered it and enter **/fileshelf**.
2. Search **Shared** by filename, extension or words around the link. Press Enter. Results are newest first. **Tool writes** also lists successful text writes Claude never linked. Repeat deliveries have their own rows.
3. Select the filename. **Read original message** displays the recorded reply directly in the pane. **Jump to chat** asks Desktop to reveal the source row when the host can locate it.
4. Choose a save action or follow the original link. FileShelf shows the exact saved path. Each save gets its own directory under `%USERPROFILE%\FileShelf Recovery`. Paste the saved path in File Explorer. **Refresh** picks up newer turns and changes on disk.

| What the shelf shows | What you can retrieve |
| --- | --- |
| Embedded attachment | The bytes of a supported base64 assistant attachment, or its embedded text. |
| Recorded Write | The UTF-8 text Claude supplied to a successful Write at or before that share. A later Edit, shell command, formatter, encoding or line-ending conversion may have changed the file. |
| Workspace file | The current contents of the referenced file inside the active project. |
| Original link | The URL Claude recorded. Downloading depends on the host, sign-in and expiry. |
| Message only | The recorded reference and message. An original Desktop card may still work. If the only copy was a deleted binary and the transcript contains just its path, the bytes cannot be reconstructed from that path. |

## What the shelf reads

FileShelf asks Claude for the active session ID, project root and transcript path. A local worker streams that transcript when you open, search or refresh the shelf, view a message, or save a copy. It recognizes inline and reference-style Markdown links, common literal file paths, assistant document and image blocks, presented project documents, published Artifact tool results, and successful file-presentation calls. A tool card displays its recorded action and path when it has no accompanying prose. Search matches the displayed filename, target and source excerpt.

No model calls, API keys, server, telemetry, or persistent transcript index. The reader never fetches remote links. Clicking an original web link hands it to the host. Local disk copies are limited to regular files inside the current project after resolving symlinks. FileShelf only writes user-requested recovery copies. The plugin does not open or run recovered files.

History availability follows the host's retention settings. A visible cloud-only attachment, unsupported card format or expired transcript can limit coverage. An incomplete or malformed JSONL record is skipped and counted in the pane, as is a single record over 96 MiB. Other records remain searchable.

## Test the plugin

Run these from the repository root with Node 22+ and Claude Code 2.1.331 or newer:

```sh
node --test tests/recovery.test.mjs
claude plugin validate .claude-plugin/marketplace.json --strict
claude plugin validate plugins/fileshelf --strict
claude plugin test plugins/fileshelf
```

The recovery suite uses synthetic conversations and real temporary files. Claude's test suite mounts the native Desktop pane and drives its controls against a stand-in for the host's process bridge. The included GitHub Actions workflow runs both suites on Windows and Linux.

For a manual Windows smoke test, ask Claude in a disposable project to use Write to create `shelf-check.md` containing `fileshelf-check-42`, then to share a Markdown link to it. Delete that test file in Explorer. In the same session, open `/fileshelf`, search for `shelf-check.md`, select **Save recorded text**, and verify that the recovered copy contains `fileshelf-check-42`.

To uninstall, run `claude plugin uninstall fileshelf@fileshelf-marketplace`. Your recovered copies stay in their recovery directory.

[Claude Code mods reference](https://code.claude.com/docs/en/plugins/mods/reference) · [Local session history](https://code.claude.com/docs/en/claude-directory) · [MIT license](LICENSE)
