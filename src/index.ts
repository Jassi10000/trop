import { Application, Context } from 'probot';
import { backportToBranch, backportToLabel } from './backport/utils';
import { PullRequest, TropConfig } from './backport/Probot';

module.exports = async (robot: Application) => {
  if (!process.env.GITHUB_FORK_USER_TOKEN) {
    robot.log.error('You must set GITHUB_FORK_USER_TOKEN');
    process.exit(1);
  }

  const backportAllLabels = (context: Context, pr: PullRequest) => {
    for (const label of pr.labels) {
      context.payload.pull_request = context.payload.pull_request || pr;
      backportToLabel(robot, context, label);
    }
  };

  // backport pull requests to labeled targets when PR is merged
  robot.on('pull_request.closed', async (context) => {
    const payload = context.payload;
    if (payload.pull_request.merged) {
      // Check if the author is us, if so stop processing
      if (payload.pull_request.user.login.endsWith('[bot]')) return;
      backportAllLabels(context, payload.pull_request as any);
    }
  });

  const TROP_COMMAND_PREFIX = '/trop ';

  // manually trigger backporting process on trigger comment phrase
  robot.on('issue_comment.created', async (context) => {
    const payload = context.payload;
    const config = await context.config<TropConfig>('config.yml');
    if (!config || !Array.isArray(config.authorizedUsers)) {
      robot.log('missing or invalid config', config);
      return;
    }

    const isPullRequest = (issue: { number: number, html_url: string }) =>
      issue.html_url.endsWith(`/pull/${issue.number}`);

    if (!isPullRequest(payload.issue)) return;

    const cmd = payload.comment.body;
    if (!cmd.startsWith(TROP_COMMAND_PREFIX)) return;

    if (!config.authorizedUsers.includes(payload.comment.user.login)) {
      robot.log.error('This user is not authorized to use trop');
      return;
    }

    const actualCmd = cmd.substr(TROP_COMMAND_PREFIX.length);

    const actions = [{
      name: 'backport sanity checker',
      command: /^run backport/,
      execute: async () => {
        const pr = (await context.github.pullRequests.get(
          context.repo({ number: payload.issue.number }))
        ).data;
        if (!pr.merged) {
          await context.github.issues.createComment(context.repo({
            number: payload.issue.number,
            body: 'This PR has not been merged yet, and cannot be backported.',
          }));
          return false;
        }
        return true;
      },
    }, {
      name: 'backport automatically',
      command: /^run backport$/,
      execute: async () => {
        const pr = (await context.github.pullRequests.get(
          context.repo({ number: payload.issue.number }))
        ).data;
        await context.github.issues.createComment(context.repo({
          body: `The backport process for this PR has been manually initiated, here we go! :D`,
          number: payload.issue.number,
        }));
        backportAllLabels(context, pr);
        return true;
      },
    }, {
      name: 'backport to branch',
      command: /^run backport-to ([^\s:]+)/,
      execute: async (targetBranches: string) => {
        const branches = targetBranches.split(',');
        for (const branch of branches) {
          robot.log(`backport-to ${branch}`);

          if (!(branch.trim())) continue;
          const pr = (await context.github.pullRequests.get(
            context.repo({ number: payload.issue.number }))
          ).data;

          try {
            (await context.github.repos.getBranch(context.repo({ branch })));
          } catch (err) {
            await context.github.issues.createComment(context.repo({
              body: `The branch you provided "${branch}" does not appear to exist :cry:`,
              number: payload.issue.number,
            }));
            return true;
          }
          await context.github.issues.createComment(context.repo({
            body: `The backport process for this PR has been manually initiated,
sending your 1's and 0's to "${branch}" here we go! :D`,
            number: payload.issue.number,
          }));
          context.payload.pull_request = context.payload.pull_request || pr;
          backportToBranch(robot, context, branch);
        }
        return true;
      },
    }];

    for (const action of actions) {
      const match = actualCmd.match(action.command);
      if (!match) continue;

      robot.log(`running action: ${action.name} for comment`);

      // @ts-ignore (false positive on next line arg count)
      if (!await action.execute(...match.slice(1))) {
        robot.log(`${action.name} failed, stopping responder chain`);
        break;
      }
    }
  });
};