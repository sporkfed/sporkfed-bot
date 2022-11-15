import {Context, Probot} from "probot";
import {EventPayloads} from "@octokit/webhooks";
import {RestEndpointMethodTypes} from "@octokit/plugin-rest-endpoint-methods/dist-types/generated/parameters-and-response-types";
import {Endpoints, RequestParameters} from "@octokit/types";
import {components} from "@octokit/openapi-types";
import {pipe} from "fp-ts/function";
import {array} from "fp-ts";
import {WebhookPayloadWithRepository} from "probot/lib/context";

// const createScheduler = require("probot-scheduler")

type ConfigRuleV1 = {
    upstream: {
        repo: {
            owner: string
            name: string
        }
        branch: string | undefined
        path: string
    }
    target: {
        path: string
        branch: string
    }
};

type ConfigV1 = {
    version: "1",
    rules: Array<ConfigRuleV1>
};

type Config =
    | ConfigV1


type GitFileContentFile = {
    _type: "file"
    data: components["schemas"]["content-file"]
}
type GitFileContentSymlink = {
    _type: "symlink"
    data: components["schemas"]["content-symlink"]
}
type GitFileContentSubmodule = {
    _type: "submodule"
    data: components["schemas"]["content-submodule"]
}
type GitFileContentDirectory = {
    _type: "directory"
    files: Array<GitFileContentFile | GitFileContentSymlink | GitFileContentSubmodule>
    path: string
};
type NullGitFileContent = {
    _type: "null"
    data: {
        sha: undefined
    }
};
const nullGitFileContent: NullGitFileContent = {
    _type: "null",
    data: {
        sha: undefined
    }
};

type GitFileContents =
    | GitFileContentFile
    | GitFileContentSymlink
    | GitFileContentSubmodule
    | GitFileContentDirectory
    | NullGitFileContent


type RawGitFileContents =
    | components["schemas"]["content-directory"]
    | components["schemas"]["content-directory"][0]
    | components["schemas"]["content-file"]
    | components["schemas"]["content-symlink"]
    | components["schemas"]["content-submodule"]


function parseGitFileContents(data: RawGitFileContents, path: string): GitFileContents {
    if (Array.isArray(data)) {
        return <GitFileContentDirectory>{
            _type: "directory",
            path,
            files: data
                .map(c => parseGitFileContents(c, c.path))
                .filter(c => !!c)
        }
    }

    switch (data.type) {
        case "file":
            return {
                _type: "file",
                data: data
            } as GitFileContentFile;
        case "symlink":
            return <GitFileContentSymlink>{
                _type: "symlink",
                data: data
            };
        case "submodule":
            return <GitFileContentSubmodule>{
                _type: "submodule",
                data: data
            };
        default:
            return nullGitFileContent;
    }
}

async function fetchFileContents(
    target: string,
    context: Context<WebhookPayloadWithRepository>,
    repo: RequestParameters & Omit<Endpoints["GET /repos/{owner}/{repo}/contents/{path}"]["parameters"], "baseUrl" | "headers" | "mediaType">,
): Promise<GitFileContents> {
    try {
        const fileContentsResults = await context.octokit.repos.getContent(repo);
        const data = fileContentsResults.data;
        context.log.info({
            tag: "fetch_file_contents_success",
            target,
            fileContents: data,
        });

        const contents = parseGitFileContents(data, repo.path);
        if (!contents) {
            context.log.warn({
                tag: "unknown_file_type",
                data
            })
        }
        return contents;
    } catch (e) {
        context.log.error({
            tag: "fetch_file_contents_error",
            target,
            err: e,
        });
        return nullGitFileContent;
    }
}

async function createBranch(
    context: Context<WebhookPayloadWithRepository>,
    targetBranch: string,
    defaultBranch: string,
) {
    try {
        await context.octokit.git.deleteRef(context.repo({
            ref: `heads/${targetBranch}`,
        }));
    } catch (e) {
        context.log.error({
            tag: "delete_branch_error",
            err: e,
        });
    }

    try {
        const defaultBranchRef: RestEndpointMethodTypes["git"]["getRef"]["response"] = await context.octokit.git.getRef(context.repo({
            ref: `heads/${defaultBranch}`,
        }))

        await context.octokit.git.createRef(context.repo({
            ref: `refs/heads/${targetBranch}`,
            sha: defaultBranchRef.data.object.sha,
        }));
    } catch (e) {
        context.log.error({
            tag: "create_branch_error",
            err: e,
        });
        throw e;
    }
}

async function createPullRequest(
    context: Context<WebhookPayloadWithRepository>,
    message: string,
    targetBranch: string,
    defaultBranch: string,
) {
    try {
        const openPullRequests: RestEndpointMethodTypes["pulls"]["list"]["response"] = await context.octokit.pulls.list(context.repo({
            state: "open",
            base: defaultBranch,
            head: targetBranch,
        }));

        context.log.error({
            tag: "open_pull_requests_error",
            openPRs: openPullRequests.data,
        });
    } catch (e) {
        context.log.error({
            tag: "list_open_pull_requests_error",
            err: e,
        });
    }

    try {
        await context.octokit.pulls.create(context.repo({
            title: message,
            base: defaultBranch,
            head: targetBranch,
        }));
    } catch (e) {
        context.log.error({
            tag: "create_pull_request_error",
            err: e,
        });
    }
}

async function updateFileContentsPR(
    context: Context<WebhookPayloadWithRepository>,
    defaultBranch: string,
    sourceFileContent: GitFileContentFile,
    targetFilePath: string,
    targetFileContent: GitFileContentFile | GitFileContentSymlink | GitFileContentSubmodule | NullGitFileContent,
): Promise<void> {
    const sourceFileSha = sourceFileContent.data.sha;
    const targetFileSha = targetFileContent.data.sha;

    if (sourceFileSha === targetFileSha) {
        context.log.info({tag: "ignore_no_changes", message: `Target is already up to date!`, targetFilePath});
        return;
    }

    const targetBranch = `sporkfed/${targetFilePath}`;
    const message = `sporkfed[bot] ${targetFileSha ? "update" : "create"} file at '${targetFilePath}'`;

    await createBranch(context, targetBranch, defaultBranch);

    const updateFileContentsResult = await context.octokit.repos.createOrUpdateFileContents(context.repo({
        path: targetFilePath,
        message: message,
        content: `${sourceFileContent.data.content}`,
        sha: targetFileSha,
        branch: targetBranch,
    }));
    context.log.info({tag: "update_target_content", updateFileContents: updateFileContentsResult.data});

    await createPullRequest(context, message, targetBranch, defaultBranch);
}

async function handleRule(
    context: Context<EventPayloads.WebhookPayloadPush>,
    rule: ConfigRuleV1
): Promise<void> {
    const defaultBranch = context.payload.repository.default_branch;

    const sourceFileContent: GitFileContents = await fetchFileContents("source", context, {
        owner: rule.upstream.repo.owner,
        repo: rule.upstream.repo.name,
        path: rule.upstream.path,
        ref: rule.upstream.branch,
    });

    const targetFileContent: GitFileContents = await fetchFileContents("target", context, context.repo({
        path: rule.target.path,
        ref: rule.target.branch,
    }));

    switch (sourceFileContent._type) {
        case "null":
            context.log.warn({tag: "source_path_not_found", message: `Source file was not found`, rule});
            return;
        case "file":
            switch (targetFileContent._type) {
                case "null":
                case "file":
                    const targetFilePath = rule.target.path;
                    await updateFileContentsPR(context, defaultBranch, sourceFileContent, targetFilePath, targetFileContent);
                    return;
                case "symlink":
                    context.log.warn({
                        tag: "unsupported_target_type",
                        message: `Target file must be of 'file' type`,
                        rule,
                        target: targetFileContent,
                    });
                    return;
                case "submodule":
                    context.log.warn({
                        tag: "unsupported_target_type",
                        message: `Target file must be of 'file' type`,
                        rule,
                        target: targetFileContent,
                    });
                    return;
                case "directory":
                    const actualTargetFilePath = `${rule.target.path}/${sourceFileContent.data.name}`;
                    const actualTargetFileContent: GitFileContentFile | GitFileContentSymlink | GitFileContentSubmodule | NullGitFileContent
                        = targetFileContent.files.find(file => file.data.path === actualTargetFilePath) ?? nullGitFileContent;

                    await updateFileContentsPR(context, defaultBranch, sourceFileContent, actualTargetFilePath, actualTargetFileContent);

                    return;
            }
            return;
        case "symlink":
            context.log.warn({
                tag: "unsupported_source_type",
                message: `Source file must be of 'file' type`,
                rule,
                source: sourceFileContent,
            });
            return;
        case "submodule":
            context.log.warn({
                tag: "unsupported_source_type",
                message: `Source file must be of 'file' type`,
                rule,
                source: sourceFileContent,
            });
            return;
        case "directory":
            context.log.warn({
                tag: "unsupported_source_type",
                message: `Source file must be of 'file' type`,
                rule,
                source: sourceFileContent,
            });
            return;
    }
}

export = (app: Probot) => {
    app.on("push", async (context: Context<EventPayloads.WebhookPayloadPush>) => {
        const defaultBranch = context.payload.repository.default_branch;
        if (context.payload.ref !== `refs/heads/${defaultBranch}`) {
            context.log.info({
                tag: "ignore_non_default_branch",
                message: "Push did not target the default branch",
                ref: context.payload.ref,
                default_branch: defaultBranch,
            });
            return
        }

        if (!context.payload.head_commit) {
            context.log.info({
                tag: "ignore_no_head_commit",
                message: "Push did not contain a head commit",
                ref: context.payload.ref,
                after_commit_id: context.payload.after,
            });
            return;
        }

        const config: Config | null = await context.config<Config>("sporkfed.yml", {version: "1", rules: []});
        if (!config) {
            context.log.info({
                tag: "ignore_no_config",
                message: "Repo does not contain config",
                ref: context.payload.ref,
                after_commit_id: context.payload.after,
            });
            return;
        }

        await pipe(
            config.rules,
            array.map(rule => handleRule(context, rule)),
            (result) => Promise.all(result),
        );
    });

    // leaving commented out so it's easy to reference during development of new hooks
    // app.onAny(async (context) => {
    //     app.log.info(context);
    // });
};
