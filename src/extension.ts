'use strict';
// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as vscode from 'vscode';
import {ProgressLocation} from 'vscode';

import * as path from 'path';
import * as clipboardy from 'clipboardy';
import axios from "axios";
import { API, GitExtension, Repository } from './typing/git';

const pugitPathToOriginalUrlCache = new Map<string, string>();

async function getGitHubRepoURL(url: string) {
    if (url.endsWith('.git')) {
        url = url.substring(0, url.length - '.git'.length);
    }
    if (url.startsWith('https://github.com/')) {
        return url;
    }
    /*
    if (url.startsWith('git@github.com:')) {
        return 'https://github.com/' + url.substring('git@github.com:'.length);
    }
    */
    // for "ssh://git@git.watchpug.com:2222/watchpug/***"
    const pugitMatchResult = (/^\w+:\/\/[^\/]+(\/watchpug\/.+)$/).exec(url);
    if (pugitMatchResult && pugitMatchResult[1]) {
        const cachedOriginalUrl = pugitPathToOriginalUrlCache.get(pugitMatchResult[1]);
        if (cachedOriginalUrl) {
            return cachedOriginalUrl;
        } else {
            const { data } = await vscode.window.withProgress(
                {
                    location: ProgressLocation.Notification,
                    title: 'GitHub linker: Fetching original url ...',
                    cancellable: false,
                },
                async () => {
                    return axios<{ original_url: string }>({
                        method: "GET",
                        url: `https://eo5451bufu073qw.m.pipedream.net${pugitMatchResult[1]}`,
                    });
                });
            pugitPathToOriginalUrlCache.set(pugitMatchResult[1], data.original_url);
            return data.original_url;
        }
    }
    // ## default github.com
    const prefixMatchResult = (/^(.+:)/).exec(url);
    const prefix = prefixMatchResult && prefixMatchResult[1];
    if (prefix) {
        return 'https://github.com/' + url.substring(prefix.length);
    }
    return null;
}

function getGitAPI(): API | undefined {
    const extension = vscode.extensions.getExtension<GitExtension>('vscode.git');
    if (!extension?.isActive || !extension.exports.enabled) {
        return undefined;
    }
    return extension.exports.getAPI(1);
}

async function findRepositoryForFile(api: API, fileName: string): Promise<Repository | undefined> {
    let best: Repository | undefined;
    let bestLength = -1;
    for (const repo of api.repositories) {
        const root = repo.rootUri.fsPath;
        if (fileName.startsWith(root + path.sep) && root.length > bestLength) {
            best = repo;
            bestLength = root.length;
        }
    }
    if (best) {
        return best;
    }

    let dir = path.dirname(fileName);
    const { root: fsRoot } = path.parse(dir);
    while (true) {
        const repo = await api.openRepository(vscode.Uri.file(dir));
        if (repo) {
            return repo;
        }
        if (dir === fsRoot) {
            return undefined;
        }
        dir = path.dirname(dir);
    }
}

async function calculateURL() {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
        throw new Error('No selected editor');
    }
    const {document, selection} = editor;
    const {fileName} = document;

    if (document.uri.scheme !== 'file') {
        throw new Error('Not a file on disk');
    }

    const api = getGitAPI();
    if (!api) {
        throw new Error('Built-in Git extension is not available or disabled');
    }
    const repo = await findRepositoryForFile(api, fileName);
    if (!repo) {
        throw new Error('No git repository found. Is this file inside a git repo?');
    }

    const head = repo.state.HEAD;
    if (!head?.commit) {
        throw new Error('Repository state is not ready yet, or the branch has no commits yet. Try again');
    }
    const sha = head.commit;

    const remotes = repo.state.remotes;
    const remote =
        remotes.find(r => r.name === head.upstream?.remote) ??
        remotes.find(r => !r.isReadOnly) ??
        remotes[0];
    const remoteUrl = remote?.fetchUrl ?? remote?.pushUrl;
    if (!remoteUrl) {
        throw new Error('No remote configured for this repository');
    }

    const repoURL = await getGitHubRepoURL(remoteUrl);
    if (!repoURL) {
        throw new Error(`The remote "${remote!.name}" is not a GitHub repository`);
    }

    const start = selection.start.line + 1;
    const end = selection.end.line + 1;

    const relativePathURL = path.relative(repo.rootUri.fsPath, fileName).split(path.sep).join('/');
    const absolutePathURL = `${repoURL}/blob/${sha}/${relativePathURL}`;

    if (start === 1 && end === document.lineCount) {
        return absolutePathURL;
    } else if (start === end) {
        return `${absolutePathURL}#L${start}`;
    }

    return `${absolutePathURL}#L${start}-L${end}`;
}

function getFileName() {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
        throw new Error('No selected editor');
    }
    const {document: {fileName}} = editor;
    return path.basename(fileName);
}

enum MarkdownDialect {
    Standard = 'Standard',
    Hacknote = 'Hacknote',
}

async function copyMarkdown(markdownDialect: MarkdownDialect) {
    try {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            throw new Error('No selected editor');
        }
        const {document, selection} = editor;

        const text = document.getText(selection);

        const finalURL = await calculateURL();

        const start = selection.start.line + 1;

        const markdown = markdownDialect === MarkdownDialect.Standard ?
            (finalURL + '\n\n```' + document.languageId + '=' + start + '\n' + text + '\n```') :
            ('```' + document.languageId + '=' + start + ' ' + `[${getFileName()}](${finalURL})` + '\n' + text + '\n```');
        clipboardy.writeSync(markdown);
        vscode.window.showInformationMessage('GitHub URL and code copied to the clipboard!');
    } catch (err) {
        if (err instanceof Error) {
            vscode.window.showErrorMessage(err.message);
        }
        throw err;
    }
}

export function activate(context: vscode.ExtensionContext) {
    context.subscriptions.push(vscode.commands.registerCommand('githublinker.copyLink', async () => {
        try {
            const finalURL = await calculateURL();
            clipboardy.writeSync(finalURL);
            vscode.window.showInformationMessage('GitHub URL copied to the clipboard!');
        } catch (err) {
            if (err instanceof Error) {
                vscode.window.showErrorMessage(err.message);
            }
            throw err;
        }
    }));

    context.subscriptions.push(vscode.commands.registerCommand('githublinker.copyMarkdown', async () => {
        await copyMarkdown(MarkdownDialect.Standard);
    }));

    context.subscriptions.push(vscode.commands.registerCommand('githublinker.copyHacknoteMarkdown', async () => {
        await copyMarkdown(MarkdownDialect.Hacknote);
    }));
}

export function deactivate() {
}
