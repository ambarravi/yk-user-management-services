import { SSMClient, GetParameterCommand } from "@aws-sdk/client-ssm";

const ssm = new SSMClient();

async function getParameter(name) {
  const command = new GetParameterCommand({ Name: name, WithDecryption: true });
  const { Parameter } = await ssm.send(command);
  return Parameter.Value;
}

export const handler = async (event) => {
  console.log("Event:", event);
  const providedSecret = event.headers["x-app-secret"];
  const appToken = event.headers["x-app-token"];
  const userAgent = event.headers["user-agent"];

  const EXPECTED_SECRET = "tikto_app_version_1"; // Hardcoded for now

  console.log("providedSecret:", providedSecret);
  console.log("EXPECTED_SECRET:", EXPECTED_SECRET);
  console.log("appToken:", appToken);
  console.log("userAgent:", userAgent);

  if (providedSecret !== EXPECTED_SECRET) {
    console.log("Secret mismatch");
    return {
      statusCode: 403,
      body: JSON.stringify({ error: "Forbidden: Secret mismatch" }),
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      },
    };
  }

  if (!appToken || appToken.length < 6) {
    console.log("Token invalid:", appToken);
    return {
      statusCode: 403,
      body: JSON.stringify({ error: "Forbidden: Invalid or missing token" }),
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      },
    };
  }

  // if (userAgent !== "MyEventApp/1.0 (Mobile)") {
  //   console.log("User-Agent mismatch:", userAgent);
  //   return {
  //     statusCode: 403,
  //     body: JSON.stringify({ error: "Forbidden: Invalid User-Agent" }),
  //     headers: {
  //       "Content-Type": "application/json",
  //       "Access-Control-Allow-Origin": "*",
  //     },
  //   };
  // }

  try {
    let redirectSignInURL;
    let redirectSignOutURL;
    console.log("BUILD ENV:", process.env.BUILD);
    if (process.env.BUILD === "DEV") {
      redirectSignInURL = process.env.redirectSignInURL; // "exp://192.168.1.3:8081/";
      redirectSignOutURL = process.env.redirectSignOutURL; //"exp://192.168.1.3:8081/";
    } else {
      redirectSignInURL = "tikto://auth";
      redirectSignOutURL = "tikto://logout";
    }

    const userPoolId = "eu-west-1_hgUDdjyRr";
    const clientId = "3apts80kiph7bafapf28ltu3vl";
    const oauthDomain = "eventmgmt.auth.eu-west-1.amazoncognito.com";
    const redirectSignIn = redirectSignInURL;
    const redirectSignOut = redirectSignOutURL;

    console.log("redirectSignIn", redirectSignIn);
    console.log("redirectSignOut", redirectSignOut);

    console.log("Returning success response from Lambda");
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
