const { SSM } = require("aws-sdk");
const ssm = new SSM();

async function getParameter(name) {
  const params = { Name: name, WithDecryption: true };
  const { Parameter } = await ssm.getParameter(params).promise();
  return Parameter.Value;
}

exports.handler = async (event) => {
  // Extract headers from the request
  const providedSecret = event.headers["x-app-secret"];
  const appToken = event.headers["x-app-token"];

  // Expected secret (fetch from Parameter Store for security)
  //const EXPECTED_SECRET = await getParameter("/app/secret"); // e.g., "my-super-secret-string-123"
  const EXPECTED_SECRET = "tikto_app_version_1"; // e.g., "my-super-secret-string-123"

  // Validate request
  if (
    providedSecret !== EXPECTED_SECRET ||
    !appToken ||
    appToken.length < 10 ||
    event.headers["user-agent"] !== "MyEventApp/1.0 (Mobile)"
  ) {
    return {
      statusCode: 403,
      body: JSON.stringify({ error: "Forbidden: Invalid request source" }),
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*", // Restrict in production
      },
    };
  }

  try {
    // Fetch sensitive values from Parameter Store (optional but recommended)
    // const userPoolId = await getParameter('/cognito/userPoolId'); // e.g., "eu-west-1_hgUDdjyRr"
    // const clientId = await getParameter('/cognito/clientId'); // e.g., "3apts80kiph7bafapf28ltu3vl"
    // const oauthDomain = await getParameter('/cognito/oauthDomain'); // e.g., "eventmgmt.auth.eu-west-1.amazoncognito.com"
    // const redirectSignIn = await getParameter('/cognito/redirectSignIn'); // e.g., "exp://192.168.1.13:8081/"
    // const redirectSignOut = await getParameter('/cognito/redirectSignOut'); // e.g., "exp://192.168.1.13:8081/"

    const userPoolId = "eu-west-1_hgUDdjyRr";
    const clientId = "3apts80kiph7bafapf28ltu3vl";
    const oauthDomain = "eventmgmt.auth.eu-west-1.amazoncognito.com";
    const redirectSignIn = "exp://192.168.1.13:8081/"; // e.g., "exp://192.168.1.13:8081/"
    const redirectSignOut = "exp://192.168.1.13:8081/"; // e.g., "exp://192.168.1.13:8081/"

    // Return Cognito config
    return {
      statusCode: 200,
      body: JSON.stringify({
        region: "eu-west-1", // Static for now; could be parameterized if needed
        userPoolId: userPoolId,
        clientId: clientId,
        oauthDomain: oauthDomain,
        redirectSignIn: redirectSignIn,
        redirectSignOut: redirectSignOut,
      }),
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*", // Adjust for production (e.g., your app’s domain)
      },
    };
  } catch (error) {
    console.error("Error fetching parameters:", error);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: "Internal server error" }),
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      },
    };
  }
};
