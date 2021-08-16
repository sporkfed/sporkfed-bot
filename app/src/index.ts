import {Context, Probot} from "probot";
import {EventPayloads, WebhookEvent} from "@octokit/webhooks";
import {RestEndpointMethodTypes} from "@octokit/plugin-rest-endpoint-methods/dist-types/generated/parameters-and-response-types";
import {Endpoints, RequestParameters} from "@octokit/types";
import {components} from "@octokit/openapi-types";

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

type FileContents =
    | components["schemas"]["content-directory"]
    | components["schemas"]["content-file"]
    | components["schemas"]["content-symlink"]
    | components["schemas"]["content-submodule"]

async function fetchFileContents(
    target: string,
    context: WebhookEvent<EventPayloads.WebhookPayloadPush> & Omit<Context, keyof WebhookEvent>,
    repo: RequestParameters & Omit<Endpoints["GET /repos/{owner}/{repo}/contents/{path}"]["parameters"], "baseUrl" | "headers" | "mediaType">,
): Promise<FileContents | undefined> {
    try {
        const fileContents = await context.octokit.repos.getContent(repo);
        context.log.info({
            tag: "fetch_file_contents_success",
            target,
            fileContents: fileContents.data,
        });

        return fileContents.data;
    } catch (e) {
        context.log.error({
            tag: "fetch_file_contents_error",
            target,
            err: e,
        });
    }

    return undefined;
}

async function createBranch(
    context: WebhookEvent<EventPayloads.WebhookPayloadPush> & Omit<Context, keyof WebhookEvent>,
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
    }
}

async function createPullRequest(
    context: WebhookEvent<EventPayloads.WebhookPayloadPush> & Omit<Context, keyof WebhookEvent>,
    message: string,
    targetBranch: string,
    defaultBranch: string,
) {
    // const openPullRequests = await context.octokit.pulls.list(context.repo({
    //     state: "open",
    //     base: defaultBranch,
    //     head: targetBranch,
    // }));
    // context.log.info({
    //     tag: "create_branch_error",
    //     openPullRequests,
    // });

    const createPullRequestResult = await context.octokit.pulls.create(context.repo({
        title: message,
        base: defaultBranch,
        head: targetBranch,
    }));
    context.log.info({
        tag: "create_pull_request_error",
        createPullRequestResult,
    });
}

export = (app: Probot) => {
    app.on("push", async (context: WebhookEvent<EventPayloads.WebhookPayloadPush> & Omit<Context, keyof WebhookEvent>) => {
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

        const config = await context.config<Config>("sporkfed.yml");
        if (!config) {
            return;
        }

        // app.log.info({config});

        for (const rule of config.rules) {
            const sourceFileContentResponse: FileContents | undefined = await fetchFileContents("source", context, {
                owner: rule.upstream.repo.owner,
                repo: rule.upstream.repo.name,
                path: rule.upstream.path,
                ref: rule.upstream.branch,
            });

            if (!sourceFileContentResponse) {
                context.log.warn({tag: "source_path_not_found", message: `Source file was not found`, rule});
                break;
            }

            if (Array.isArray(sourceFileContentResponse)) {
                context.log.warn({message: `Source file must be of 'file' type`, rule, type: `directory`});
                break;
            }

            // @ts-ignore
            const sourceFileContent = sourceFileContentResponse.content;
            if (!sourceFileContent) {
                context.log.warn({
                    tag: "unsupported_source_type",
                    message: `Source file must be of 'file' type`,
                    rule,
                    type: sourceFileContentResponse.type
                });
                break;
            }

            const targetFileContentResponse: FileContents | undefined = await fetchFileContents("target", context, context.repo({
                path: rule.target.path,
                ref: rule.target.branch,
            }));

            if (targetFileContentResponse && Array.isArray(targetFileContentResponse)) {
                context.log.warn({tag: "unsupported_target_type", message: `Target file must be of 'file' type`, rule});
                break;
            }

            const sourceFileSha = sourceFileContentResponse.sha;
            const targetFileSha = targetFileContentResponse?.sha;

            if (sourceFileSha === targetFileSha) {
                context.log.info({tag: "ignore_no_changes", message: `Target is already up to date!`, rule});
                break;
            }

            const targetBranch = `sporkfed/${rule.target.path}`;
            await createBranch(context, targetBranch, defaultBranch);

            const message = `sporkfed[bot] ${targetFileSha ? "update" : "create"} file at '${rule.target.path}'`;

            const updateFileContentsResult = await context.octokit.repos.createOrUpdateFileContents(context.repo({
                path: rule.target.path,
                message: message,
                content: `${sourceFileContent}`,
                sha: targetFileSha,
                branch: targetBranch,
            }));
            context.log.info({tag: "update_target_content", updateFileContents: updateFileContentsResult.data});

            await createPullRequest(context, message, targetBranch, defaultBranch);
        }
    });

    // leaving commented out so it's easy to reference during development of new hooks
    // app.onAny(async (context) => {
    //     app.log.info(context);
    // });
};
