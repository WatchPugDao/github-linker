'use strict';
// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as vscode from 'vscode';
import {ProgressLocation} from 'vscode';

import * as path from 'path';
import * as fs from 'fs';
import * as ini from 'ini';
import * as clipboardy from 'clipboardy';
import axios from "axios";

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

function findGitFolder(fileName: string): string {
    let dir = path.dirname(fileName)
    const { root } = path.parse(dir)
    let gitDir = null;
    while (true) {
        gitDir = path.join(dir, '.git');
        const exits = fs.existsSync(gitDir);
        if (exits) {
            console.log(gitDir);
            break;
        } else if (dir === root) {
            gitDir = null;
            break;
        }
        dir = path.dirname(dir);
    }

    if (!gitDir) {
        throw new Error('No .git dir found. Is this a git repo?');
    }

    return gitDir
}

function getWorktreePath(gitPath: string) {
    if (fs.statSync(gitPath).isFile()) {
        // not a normal .git dir, could be a `git worktree`, read the file to find the real root
        const text = fs.readFileSync(gitPath).toString()

        console.log('gitPath is a file, checking to see if worktree', { text })

        const worktreePrefix = 'gitdir: ';

        if (text.startsWith(worktreePrefix)) {
            return text.slice(worktreePrefix.length).trim();
        }
    }
}

async function calculateURL() {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
        throw new Error('No selected editor');
    }
    const {document, selection} = editor;
    const {fileName} = document;

    let gitDir = findGitFolder(fileName);

    const baseDir = path.join(gitDir, '..')

    const worktreePath = getWorktreePath(gitDir)

    if (worktreePath) {
        gitDir = path.join(worktreePath, '..', '..')
    }

    const relativePath = path.relative(baseDir, fileName);

    const head = fs.readFileSync(path.join(worktreePath || gitDir, 'HEAD'), 'utf8');
    const refPrefix = 'ref: ';
    const ref = head.split('\n').find(line => line.startsWith(refPrefix));
    if (!ref) {
        throw new Error('No ref found. Cannot calculate current commit');
    }
    const refName = ref.substring(refPrefix.length);
    const sha = fs.readFileSync(path.join(gitDir, refName), 'utf8').trim();

    const gitConfig = ini.parse(fs.readFileSync(path.join(gitDir, 'config'), 'utf8'));

    const branchInfo = Object.values(gitConfig).find(val => val['merge'] === refName);
    const remote = (() => {
        if (branchInfo) {
            return branchInfo['remote'];
        } else {
            vscode.window.showInformationMessage('No branch info found. Try use first remote');
            for (const entry of Object.entries(gitConfig)) {
                const matchResult = (/remote "(.+)"/).exec(entry[0]);
                if (matchResult && matchResult[1]) {
                    return matchResult[1];
                }
            }
        }
    })();
    const remoteInfo = Object.entries(gitConfig).find((entry) => entry[0] === `remote "${remote}"`);
    if (!remoteInfo) {
        throw new Error(`No remote found called "${remote}"`);
    }
    const url = remoteInfo[1]['url'];
    const repoURL = await getGitHubRepoURL(url);
    if (!url) {
        throw new Error(`The remote "${remote}" does not look like to be hosted at GitHub`);
    }

    const start = selection.start.line + 1;
    const end = selection.end.line + 1;

    const relativePathURL = relativePath.split(path.sep).join('/');
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
