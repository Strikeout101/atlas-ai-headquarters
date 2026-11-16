# Social accounts: Instagram first

The owner posts content. Agents use the saved account context to plan ideas,
captions, and drafts. This implementation does not publish content, upload media,
send DMs, reply to comments, or create social accounts.

## What works now

- Save multiple Instagram account handles for either business. A handle-only entry
  is a planning profile, clearly marked **not connected**.
- Optionally enter an authorized Instagram user access token in Settings. The
  server encrypts it using the same credential key as mailbox credentials. Saved
  tokens and ciphertext are never returned to the UI or worker gateway.
- Test a saved connection through Meta's read-only `/me` endpoint. The returned
  username must match the saved handle. Only then is the entry marked verified.
- Explicitly load up to ten recent post references for a verified connection.
  This returns media type, Instagram link, and timestamp for planning; it does not
  download images or videos and never follows provider pagination URLs.
- Disconnect removes the stored token and verification while retaining the
  account's planning profile. Remove deletes the entry entirely.

Verification means the last test succeeded, not that a token will remain valid.
Tokens expire or may be revoked; no automatic refresh is implemented in this
increment. The account API returns the last-test timestamp. Failed tests return safe error
codes rather than raw provider payloads.

## Connect Primrose's Instagram

1. Confirm `primroseevents_` is an Instagram professional account (Business or
   Creator). This API does not use Instagram Basic Display for personal accounts.
2. Create/configure a Meta Business app and add Instagram API with Instagram Login.
   For the owner's own account, add the account in the app dashboard with the
   appropriate app role/access. Connecting accounts outside the app's own managed
   accounts requires the applicable review/access level.
3. Request the read-only `instagram_business_basic` permission. Use the app
   dashboard's **Generate token** flow for the account. An app-specific OAuth login
   flow is not yet built into ATLAS.
4. In Settings > Businesses > Social accounts, save the Instagram handle, enter the
   token in its password-style credential field, save, and test. Do not paste the
   token into chat, task descriptions, business profile notes, or draft content.

The test uses `https://graph.instagram.com/v27.0/me` with `user_id,username`.
Requests only target that fixed provider endpoint, reject redirects, and have a
15-second timeout. Tokens are sent in the Authorization header rather than request
URLs. Safe account metadata is available to active workers through
`business.social.accounts`; `business.social.media` reads recent media when given
the saved `account_id`. Both reads use server-managed credentials.

The media reader uses the fixed `/{IG_ID}/media` endpoint with a limit of ten and
normalizes only ID, media type, permalink, and timestamp. Captions are currently
returned as absent: Meta's current media reference labels that field available for
Facebook Login only, while this integration uses Instagram Login. There is no
analytics or comment-reading implementation in this increment.

## Later steps

The next useful extension is account insights to inform planning, after choosing
the data needed and permissions. Owner-managed posting continues unless the owner
changes that preference.

TikTok is deferred. Its identity API requires authorized scopes; username access
needs `user.info.profile` in addition to basic identity. Direct publishing requires
its Content Posting API approval and user consent; unaudited clients face visibility
restrictions. None of those capabilities is enabled here.

Official references checked November 15, 2026:

- [Instagram Get Started](https://developers.facebook.com/documentation/instagram-platform/instagram-api-with-instagram-login/get-started)
- [Business Login for Instagram](https://developers.facebook.com/documentation/instagram-platform/instagram-api-with-instagram-login/business-login)
- [Instagram Media reference](https://developers.facebook.com/documentation/instagram-platform/reference/instagram-media)
- [TikTok user information](https://developers.tiktok.com/docs/en/tiktok-api-v2-get-user-info)
- [TikTok Direct Post setup](https://developers.tiktok.com/docs/en/content-posting-api-get-started)
