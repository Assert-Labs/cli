# Contributing to Assert

We welcome contributions to Assert and appreciate your interest in what we are building. The following guide is intended to facilitate a successful interaction between you as a contributor and us as the maintainers.

## Where You Can Contribute

There are a few areas to contribute that we will outline:

- **Feature Requests**: Something missing in Assert that you would like to see.
- **Bug Reports**: An issue you have run into that you believe is unintended.
- **Security Concerns**: A possible vulnerability you have discovered.
- **Miscellaneous**: Documentation, test coverage, etc.

### Feature Requests

Before opening a pull request for a feature you'd like to see implemented, please begin by doing the following:

- Search pull requests and issues to see if the feature is already in-progress or has been discussed previously.
- If you don't find anything about it, [open a new issue](https://github.com/assert-labs/cli/issues) to align with maintainers.
- Wait for feedback or discussion before coding. We may decide to ship a feature ourselves or ask you to open a pull request for it.

Some features might not align with our vision or roadmap, or might impose a large maintenance burden - we will do our utmost to support requests!

### Bug Reports

The process for reporting a bug should look similar to a feature request (start with looking at prior discussion and open an issue). That said, if in the process of reproducing a bug you end up resolving it and are confident it is an issue, you may submit a pull request directly.

When reporting a bug, please include the following information for the purpose of reproducing the issue. If you are unable to reproduce the issue or can only reproduce it unreliably, please say so and provide as much information as you can. The more detailed you can be, the better:

1. Context: Assert version, operating system, etc.
2. What happened: commands you ran, actions you took, output, error messages, screenshots, screen recordings, etc.
3. What you expected (optional): in some cases, you might reasonably have weak priors about what was supposed to occur

### Security

> [!NOTE]
> Please do not open an issue or a pull request on GitHub for a security vulnerability.

If you would like to report a possible security vulnerability or need to reach us about Assert's security posture, please send an email to [security@assert.dev](mailto:security@assert.dev). All security reports are kept confidential and we appreciate you disclosing responsibly.

## Best Practices For Contributing

### Using Assert

We use Assert to build Assert and ask that you do the same while contributing. Download the latest version of Assert and run `assert init` to set up coding agent plugins. When you submit your pull request, please leave changes to `.sessions/` intact so that we may use context from your sessions during review. Hopefully, using the CLI while working will give you a feel for its strengths and weaknesses.

If at the time of contributing you use a coding agent that is not yet supported by Assert, please state that somewhere in the PR description.

### Before Requesting Human Review

Before requesting or re-requesting a human reviewer, please do your best to take the following steps:

- Build, type-check, and test the package: see the [package.json](package.json) for relevant commands.
- Make sure that the PR is mergeable: fix CI failures and resolve merge conflicts with main.
- Respond to automated feedback: we may use automated reviewers to catch issues. Please do your best to respond to comments from these reviews by either responding directly to their feedback and/or pushing changes to address the issues they surface.

---

## Discord

[Join our server](https://discord.gg/YqKKrBmam) to ask questions and engage in discussions!
