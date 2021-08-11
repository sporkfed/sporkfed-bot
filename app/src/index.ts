import {Probot} from "probot";

export = (app: Probot) => {
    app.on("issues.opened", async (context) => {
        const issueComment = context.issue({
            body: "Thanks for opening this issue!",
        });
        await context.octokit.issues.createComment(issueComment);
    });

    app.onAny(async (context) => {
        app.log.info({event: context.name, action: context.payload.action});
    });
};
