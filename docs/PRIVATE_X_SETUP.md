# Connect X privately

This step is needed before real account scans and post collection can start. Development on the dashboard and intelligence can continue without it.

1. Use the existing active **Bearer Token** for the X app associated with your credit balance. Jacob confirmed he wants to use that token; generating a replacement is not a setup requirement. If you need to locate it, open the existing app in the [X Developer Console](https://console.x.com) under **Keys and tokens**. The product needs only the bearer token.
2. Open the local [Caucus Pulse preview](http://127.0.0.1:4317), choose **Coverage & budget**, and find **Private X connection**.
3. Paste the existing active bearer token into the password field and select **Save privately**. Do not send the token through chat. A saved message confirms local storage only; it does not start collection or spend credits.

The token stays in an owner-readable file on this computer, outside Git. It is not returned by dashboard responses. If the form says a runtime environment supplies the token, that existing private environment must be updated instead.

Codex will then check access and balance, run a bounded account scan and small post trial within the recorded budget, inspect the results, and finish member-account verification. No credit purchase or new paid service is part of this setup.

If the local preview is unavailable, return to this task; Codex can restart it. Backend saving, access restrictions, and token exclusion from responses have been tested. Visual browser verification is still pending because the browser's administrative-policy check was unavailable.
