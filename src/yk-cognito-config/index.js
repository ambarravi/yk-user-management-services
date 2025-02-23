// index.js
import { SSMClient, GetParameterCommand } from "@aws-sdk/client-ssm";

const ssm = new SSMClient();

async function getParameter(name) {
  const command = new GetParameterCommand({ Name: name, WithDecryption: true });
  const { Parameter } = await ssm.send(command);
  return Parameter.Value;
}

export const handler = async (event) => {
  console.log(event);
  const providedSecret = event.headers["x-app-secret"];
  const appToken = event.headers["x-app-token"];

  //const EXPECTED_SECRET = await getParameter("/app/secret"); // e.g., "my-super-secret-string-123"
  const EXPECTED_SECRET = "tikto_app_version_1"; // e.g., "my-super-secret-string-123"

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
        "Access-Control-Allow-Origin": "*",
      },
    };
  }

  try {
    // const userPoolId = await getParameter('/cognito/userPoolId');
    // const clientId = await getParameter('/cognito/clientId');
    // const oauthDomain = await getParameter('/cognito/oauthDomain');
    // const redirectSignIn = await getParameter('/cognito/redirectSignIn');
    // const redirectSignOut = await getParameter('/cognito/redirectSignOut');

    const userPoolId = "eu-west-1_hgUDdjyRr";
    const clientId = "3apts80kiph7bafapf28ltu3vl";
    const oauthDomain = "eventmgmt.auth.eu-west-1.amazoncognito.com";
    const redirectSignIn = "exp://192.168.1.13:8081/"; // e.g., "exp://192.168.1.13:8081/"
    const redirectSignOut = "exp://192.168.1.13:8081/"; // e.g., "exp://192.168.1.13:8081/"
    console.log("Return success reponse from Lambda");
    return {
      statusCode: 200,
      body: JSON.stringify({
        region: "eu-west-1",
        userPoolId,
        clientId,
        oauthDomain,
        redirectSignIn,
        redirectSignOut,
      }),
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
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
