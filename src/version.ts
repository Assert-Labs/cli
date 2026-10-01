/**
 * The CLI version, injected by the build (`__ASSERT_VERSION__`); "dev" when
 * running from source via tsx.
 */
declare const __ASSERT_VERSION__: string;

export const VERSION: string =
  typeof __ASSERT_VERSION__ === 'string' ? __ASSERT_VERSION__ : 'dev';
