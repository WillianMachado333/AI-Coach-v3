Hi Manas,

I fixed the issues they should be visible to you in dev mode.

1. For guest users, no text limitation is set, and no limitation event is triggered.
   This is correct behavior - text is intentionally unlimited for all users per specifications.

2. For guest users, no sign-up prompt event is received.
   Added missing messageToApp bridge to send ericaShowSignUpPrompt action to native apps.

3. For guest users, text chat sometimes returns an error in the response.
   Fixed QC system logic bug that was allowing malformed messages to slip through.

4. For free members, no limitation event is received for either text or voice, even after reaching the limit.
   Added Voice Limit Reached, Shown Upgrade Prompt, and Requested Upgrade analytics events.

5. The upgrade membership event is not received.
   Added missing messageToApp bridge to send ericaRequestUpgrade action to native apps.

6. Sometimes, it takes longer than expected to connect with the AI coach.
   Optimized connection flow by skipping redundant history fetch when preparation already provides it.

Best regards,
Willian
