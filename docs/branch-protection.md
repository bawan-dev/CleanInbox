# Branch protection

These repository settings are required for safe collaboration and are not enforced by source control within the repository itself.

## Required repository configuration

- Protect the default branch from direct pushes.
- Require pull requests for changes to the default branch.
- Require status checks to pass before merge.
- Require a reviewed pull request and at least one approver for changes to production-relevant branches.
- Prevent force pushes to protected branches.
- Require a clean working tree before release promotion.

## Current owner action required

- OWNER ACTION REQUIRED: confirm the protected branch names and the required reviewer/approval policy for this repository.
- OWNER ACTION REQUIRED: confirm the CI workflow file in [.github/workflows/ci.yml](../.github/workflows/ci.yml) is the required enforcement mechanism for the selected branch policy.
