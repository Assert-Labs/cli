// The suite's hook and recorder tests predate the upload transport and assert
// on the repo-local `.sessions/` layout, so they run in the `repo` publish
// mode. Tests of the `assert` mode set ASSERT_PUBLISH themselves.
process.env.ASSERT_PUBLISH = 'repo';
