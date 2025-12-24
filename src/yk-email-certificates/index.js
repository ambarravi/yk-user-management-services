import {
  DynamoDBClient,
  UpdateItemCommand,
  GetItemCommand,
  PutItemCommand,
  QueryCommand,
} from "@aws-sdk/client-dynamodb";
import {
  S3Client,
  GetObjectCommand,
  PutObjectCommand,
} from "@aws-sdk/client-s3";
import { SESClient, SendRawEmailCommand } from "@aws-sdk/client-ses";
import { createCanvas, loadImage, registerFont } from "canvas";
import QRCode from "qrcode";
import { v4 as uuidv4 } from "uuid";
import fs from "fs/promises";

// Utility function to wrap text
const wrapText = (ctx, text, maxWidth, fontStr) => {
  ctx.font = fontStr;
  const words = text.split(" ");
  const lines = [];
  let currentLine = "";

  for (const word of words) {
    const testLine = currentLine ? `${currentLine} ${word}` : word;
    const metrics = ctx.measureText(testLine);
    const testWidth = metrics.width;

    if (testWidth > maxWidth && currentLine !== "") {
      lines.push(currentLine);
      currentLine = word;
    } else {
      currentLine = testLine;
    }
  }
  if (currentLine) {
    lines.push(currentLine);
  }

  return lines;
};

// Extract DynamoDB attribute value with default
const extractAttr = (attr, defaultValue = 0) => {
  if (!attr) return defaultValue;
  if (attr.N !== undefined) return parseInt(attr.N, 10);
  if (attr.S !== undefined) return attr.S;
  if (attr.BOOL !== undefined) return attr.BOOL;
  return defaultValue;
};

// Utility to convert stream to buffer
async function streamToBuffer(stream) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    stream.on("data", (chunk) => chunks.push(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolve(Buffer.concat(chunks)));
  });
}

// // Load fonts from S3
// async function loadFonts(s3Client, bucket, fontFiles) {
//   for (const font of fontFiles) {
//     try {
//       const fontData = await s3Client.send(
//         new GetObjectCommand({ Bucket: bucket, Key: font.path })
//       );
//       const fontBuffer = await streamToBuffer(fontData.Body);
//       registerFont(fontBuffer, {
//         family: font.family,
//         weight: font.weight || "normal",
//       });
//     } catch (err) {
//       console.error(`Failed to load font ${font.path}:`, err);
//     }
//   }
// }

async function loadFonts(s3Client, bucket, fontFiles) {
  for (const font of fontFiles) {
    try {
      const fontData = await s3Client.send(
        new GetObjectCommand({ Bucket: bucket, Key: font.path })
      );
      const fontBuffer = await streamToBuffer(fontData.Body);

      // Write buffer to temp file
      const tempPath = `/tmp/${font.path.split("/").pop()}`; // e.g., /tmp/merriweather.regular.ttf
      await fs.writeFile(tempPath, fontBuffer);

      // Register with path
      registerFont(tempPath, {
        family: font.family,
        weight: font.weight || "normal",
      });
      console.log(`Registered font: ${font.family} from ${tempPath}`);
    } catch (err) {
      console.error(`Failed to load font ${font.path}:`, err);
    }
  }
}

// Fetch template metadata and image
async function fetchTemplate(ddbClient, s3Client, bucket, templateId) {
  const templateParams = {
    TableName: "CertificateTemplates",
    Key: { TemplateID: { S: templateId } },
  };
  const templateResult = await ddbClient.send(
    new GetItemCommand(templateParams)
  );
  if (!templateResult.Item) {
    throw new Error(`Template ${templateId} not found in DynamoDB`);
  }

  const templateMetadata = {
    templateId: templateId,
    name: templateResult.Item.TemplateName.S,
    dimensions: {
      width: extractAttr(templateResult.Item.Dimensions?.M?.width, 800),
      height: extractAttr(templateResult.Item.Dimensions?.M?.height, 600),
    },
    placeholders: templateResult.Item.Placeholders.L.map((p) => ({
      id: p.M?.id?.S || "",
      type: p.M?.type?.S || "text",
      position: {
        x: extractAttr(p.M?.position?.M?.x, 0),
        y: extractAttr(p.M?.position?.M?.y, 0),
      },
      style: {
        fontSize: extractAttr(p.M?.style?.M?.fontSize, 12),
        fontFamily: p.M?.style?.M?.fontFamily?.S || "Arial",
        color: p.M?.style?.M?.color?.S || "#000000",
        align: p.M?.style?.M?.align?.S || "left",
        fontWeight: p.M?.style?.M?.fontWeight?.S || "normal",
        radius: extractAttr(p.M?.style?.M?.radius),
      },
      maxWidth: extractAttr(p.M?.maxWidth, 800),
      lineHeight: extractAttr(p.M?.lineHeight, 60),
      size: p.M?.size
        ? {
            width: extractAttr(p.M.size.M?.width),
            height: extractAttr(p.M.size.M?.height),
          }
        : undefined,
    })),
  };

  // Load template image dynamically

  const templateKey = templateResult.Item?.TemplateS3Key?.S;
  if (!templateKey) {
    throw new Error(`No TemplateS3Key for ${templateId}`);
  }
  const templateData = await s3Client.send(
    new GetObjectCommand({ Bucket: bucket, Key: templateKey })
  );
  const templateBuffer = await streamToBuffer(templateData.Body);
  const templateImg = await loadImage(templateBuffer);

  return { templateMetadata, templateImg };
}

// Fetch and load logo image
async function fetchLogo(ddbClient, orgID) {
  try {
    const orgParams = {
      TableName: "Organizer",
      Key: { OrganizerID: { S: orgID } },
    };
    const orgResult = await ddbClient.send(new GetItemCommand(orgParams));
    if (!orgResult.Item || !orgResult.Item.logoPath?.S) {
      console.error(`No logoPath found for OrganizerID ${orgID}`);
      return null;
    }
    const logoPath = orgResult.Item.logoPath.S;
    return await loadImage(logoPath);
  } catch (err) {
    console.error(`Error fetching logo for OrganizerID ${orgID}:`, err);
    return null;
  }
}

// Generate certificate image and ID
async function generateCertificate(
  templateMetadata,
  templateImg,
  logoImg,
  name,
  eventName,
  certificateInfo
) {
  const { width, height } = templateMetadata.dimensions;
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext("2d");

  // Draw background
  ctx.drawImage(templateImg, 0, 0, width, height);

  // Generate unique CertificateID
  const certificateId = uuidv4();

  // Generate QR code
  const qrCodeUrl = `https://tikties.com/certificate/verify/${certificateId}`;
  const qrDataUrl = await QRCode.toDataURL(qrCodeUrl, { margin: 1 });
  const qrImg = await loadImage(qrDataUrl);

  // Sample data for placeholders
  const sampleData = {
    certificate_info: certificateInfo,
    student_name: name,
    event_name: eventName,
    qr_code: qrImg,
    logo: logoImg,
    note: "This certificate has been issued digitally through Tikties.com",
  };

  // Draw placeholders
  templateMetadata.placeholders.forEach((placeholder) => {
    const pos = placeholder.position;
    if (placeholder.type === "text") {
      let text = sampleData[placeholder.id] || "";
      if (typeof text !== "string") text = String(text);
      const fontWeight = placeholder.style.fontWeight || "normal";
      const fontStr = `${fontWeight} ${placeholder.style.fontSize}px ${placeholder.style.fontFamily}`;
      ctx.font = fontStr;
      ctx.fillStyle = placeholder.style.color;
      ctx.textAlign = placeholder.style.align || "left";
      ctx.textBaseline = "top";

      const lines = wrapText(ctx, text, placeholder.maxWidth, fontStr);

      const lineHeight =
        placeholder.lineHeight || placeholder.style.fontSize * 1.2;
      lines.forEach((line, index) => {
        ctx.fillText(line, pos.x, pos.y + index * lineHeight);
      });
    } else if (placeholder.type === "qr" && placeholder.size) {
      ctx.drawImage(
        sampleData.qr_code,
        pos.x,
        pos.y,
        placeholder.size.width,
        placeholder.size.height
      );
    } else if (
      placeholder.type === "image" &&
      sampleData[placeholder.id] &&
      placeholder.size
    ) {
      const radius = placeholder.style.radius || 0;
      ctx.save();
      if (radius > 0) {
        ctx.beginPath();
        ctx.arc(
          pos.x + placeholder.size.width / 2,
          pos.y + placeholder.size.height / 2,
          radius,
          0,
          Math.PI * 2
        );
        ctx.clip();
      }
      ctx.drawImage(
        sampleData[placeholder.id],
        pos.x,
        pos.y,
        placeholder.size.width,
        placeholder.size.height
      );
      ctx.restore();
    }
  });

  const buffer = canvas.toBuffer("image/png");
  return { buffer, certificateId, qrCodeUrl };
}

// Upload certificate to S3
async function uploadCertificate(s3Client, bucket, eventId, userId, buffer) {
  const certKey = `${eventId}/${userId}/certificate.png`;
  await s3Client.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: certKey,
      Body: buffer,
      ContentType: "image/png",
    })
  );
  return certKey;
}

// Store certificate details in DynamoDB
async function storeCertificate(
  ddbClient,
  eventId,
  email,
  userId,
  certificateId,
  certKey,
  name,
  eventName,
  certificateInfo,
  qrCodeUrl,
  status
) {
  // Check if certificate already generated before storing
  // const exists = await checkCertificateExists(ddbClient, eventId, email);
  // if (exists) {
  //   console.log(`Certificate already generated for eventId: ${eventId}, email: ${email}`);
  //   return;
  // }

  let item = {
    CertificateID: { S: certificateId }, // Primary partition key
    EventID: { S: eventId },
    AttendeeEmail: { S: email },
    UserID: { S: userId },
    CertificateStatus: { S: status },
    Name: { S: name },
    IssueDate: { S: new Date().toISOString() },
  };

  if (certKey) {
    item.CertificateS3Key = { S: certKey };
  }

  if (status === "Generated") {
    item.EventName = { S: eventName };
    item.CertificateInfo = { S: certificateInfo };
    item.QRCodeUrl = { S: qrCodeUrl };
  }

  await ddbClient.send(
    new PutItemCommand({
      TableName: "CertificateRecipients",
      Item: item,
    })
  );
}

// Check if certificate already generated
async function checkCertificateExists(ddbClient, eventId, email) {
  const checkCertParams = {
    TableName: "CertificateRecipients",
    IndexName: "eventID-email-index",
    KeyConditionExpression: "#eventId = :eventId AND #email = :email",
    ExpressionAttributeNames: {
      "#eventId": "EventID",
      "#email": "AttendeeEmail",
    },
    ExpressionAttributeValues: {
      ":eventId": { S: eventId },
      ":email": { S: email },
    },
    ProjectionExpression: "CertificateStatus", // Optional: project only the status to optimize
  };

  try {
    const checkResult = await ddbClient.send(new QueryCommand(checkCertParams));
    // Assuming unique combination; check the first (and only) item
    return (
      checkResult.Items &&
      checkResult.Items.length > 0 &&
      checkResult.Items[0].CertificateStatus?.S === "Generated"
    );
  } catch (err) {
    console.error(`Error checking CertificateRecipients for ${email}:`, err);
    return false;
  }
}

// Check booking and attendance
async function checkAndGetBooking(ddbClient, eventId, email) {
  try {
    const queryParams = {
      TableName: "BookingDetails",
      IndexName: "EventBookingIndex",
      KeyConditionExpression: "EventID = :eventId AND BookingEmail = :email",
      ExpressionAttributeValues: {
        ":eventId": { S: eventId },
        ":email": { S: email },
      },
    };
    const queryResult = await ddbClient.send(new QueryCommand(queryParams));

    if (queryResult.Items.length > 0) {
      const bookingItem = queryResult.Items[0];
      if (!bookingItem.MarkAttendance?.BOOL) {
        return { exists: true, attended: false, bookingItem: null };
      }
      return { exists: true, attended: true, bookingItem };
    } else {
      return { exists: false, attended: true, bookingItem: null };
    }
  } catch (err) {
    console.error(`Error querying BookingDetails for ${email}:`, err);
    return { exists: false, attended: false, bookingItem: null };
  }
}

// Update booking with certificate issued
async function updateBookingCertificate(ddbClient, bookingId) {
  try {
    const updateBookingParams = {
      TableName: "BookingDetails",
      Key: { BookingID: bookingId },
      UpdateExpression: "SET CertificateIssued = :true",
      ExpressionAttributeValues: { ":true": { BOOL: true } },
    };
    await ddbClient.send(new UpdateItemCommand(updateBookingParams));
  } catch (err) {
    console.error(
      `Error updating BookingDetails for booking ${bookingId}:`,
      err
    );
  }
}

// Send certificate email (separate module function) Updated test comment to reflect changes
async function sendCertificateEmail(
  sesClient,
  email,
  buffer,
  subject = "Your Event Certificate",
  textBody = "Please find your certificate attached.",
  isTestMode = false
) {
  const fromEmail = "support@tikties.com";
  const attachmentBase64 = buffer.toString("base64");
  const rawEmail = `From: ${fromEmail}\r\nTo: ${email}\r\nSubject: ${subject}\r\nMIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary="NextPart"\r\n\r\n--NextPart\r\nContent-Type: text/plain\r\n\r\n${textBody}\r\n\r\n--NextPart\r\nContent-Type: image/png; name="certificate.png"\r\nContent-Transfer-Encoding: base64\r\nContent-Disposition: attachment\r\n\r\n${attachmentBase64}\r\n--NextPart--`;

  if (isTestMode) {
    console.log(`[TEST MODE] Would send email:`);
    console.log(`  To: ${email}`);
    console.log(`  From: ${fromEmail}`);
    console.log(`  Subject: ${subject}`);
    console.log(`  Body: ${textBody}`);
    console.log(`  Attachment: certificate.png (${buffer.length} bytes)`);
    return;
  }

  try {
    await sesClient.send(
      new SendRawEmailCommand({
        RawMessage: { Data: Buffer.from(rawEmail) },
      })
    );
  } catch (err) {
    console.error(`Error sending email to ${email}:`, err);
    throw err;
  }
}

// Update event status and certificate issued count
async function updateEventStatus(
  ddbClient,
  eventId,
  processedCount = 0,
  tableName = process.env.DYNAMODB_EVENT_TABLE
) {
  try {
    let updateExpression = "SET CertificateStatus = :status";
    const expressionValues = { ":status": { S: "Completed" } };

    if (processedCount > 0) {
      updateExpression += " ADD CertificateIssuedCount :count";
      expressionValues[":count"] = { N: processedCount.toString() };
    }

    const updateParams = {
      TableName: tableName,
      Key: { EventID: { S: eventId } },
      UpdateExpression: updateExpression,
      ExpressionAttributeValues: expressionValues,
    };
    await ddbClient.send(new UpdateItemCommand(updateParams));
  } catch (err) {
    console.error(`Error updating event status/count for ${eventId}:`, err);
    throw err;
  }
}

// Process single attendee
async function processAttendee(
  ddbClient,
  s3Client,
  sesClient,
  bucket,
  eventId,
  eventName,
  orgID,
  showLogo,
  templateMetadata,
  templateImg,
  logoImg,
  attendee,
  certificateInfo,
  isTestMode
) {
  const { name, email } = attendee;
  if (!name || !email) {
    console.log(`Skipping attendee: missing name or email`);
    return false;
  }

  // Generate UserID from email
  const userId = email.replace(/[^a-zA-Z0-9]/g, "-");

  // Check if certificate already exists
  if (await checkCertificateExists(ddbClient, eventId, email)) {
    console.log(
      `Certificate already generated for ${email} in event ${eventId}, skipping`
    );
    return false;
  }

  // Check attendance in BookingDetails
  const bookingCheck = await checkAndGetBooking(ddbClient, eventId, email);

  // Always allow if no booking (additional recipient)
  let isAdditionalRecipient = !bookingCheck.exists;
  if (isAdditionalRecipient) {
    console.log(
      `No booking found for ${email} in event ${eventId}, processing as additional recipient`
    );
  } else if (!bookingCheck.attended) {
    // Force-allow for payload attendees by overriding as additional recipient
    console.log(
      `Attendance not marked for ${email} in event ${eventId}, but forcing as additional (override)`
    );
    isAdditionalRecipient = true;
  }

  // Proceed only if attended OR additional
  if (!isAdditionalRecipient && !bookingCheck.attended) {
    console.log(
      `Attendance not marked for ${email} in event ${eventId}, skipping`
    );
    return false;
  }

  // Generate certificate
  const { buffer, certificateId, qrCodeUrl } = await generateCertificate(
    templateMetadata,
    templateImg,
    logoImg,
    name,
    eventName,
    certificateInfo
  );

  let certKey;
  try {
    certKey = await uploadCertificate(
      s3Client,
      bucket,
      eventId,
      userId,
      buffer
    );
  } catch (err) {
    console.error(`Error uploading to S3 for ${email}:`, err);
    // Store failure status in DynamoDB
    await storeCertificate(
      ddbClient,
      eventId,
      email.toLowerCase(),
      userId,
      certificateId,
      null,
      name,
      eventName,
      certificateInfo,
      qrCodeUrl,
      "Failed"
    );
    return false;
  }

  // Send email with attachment
  try {
    await sendCertificateEmail(
      sesClient,
      email.toLowerCase(),
      buffer,
      "Your Event Certificate",
      "Please find your certificate attached.",
      isTestMode
    );
  } catch (err) {
    console.error(`Error sending email to ${email}:`, err);
    // Store failure status in DynamoDB
    await storeCertificate(
      ddbClient,
      eventId,
      email.toLowerCase(),
      userId,
      certificateId,
      certKey,
      name,
      eventName,
      certificateInfo,
      qrCodeUrl,
      "Failed"
    );
    return false;
  }

  // Store certificate details in CertificateRecipients
  try {
    await storeCertificate(
      ddbClient,
      eventId,
      email.toLowerCase(),
      userId,
      certificateId,
      certKey,
      name,
      eventName,
      certificateInfo,
      qrCodeUrl,
      "Generated"
    );
  } catch (err) {
    console.error(`Error storing certificate details for ${email}:`, err);
    throw err; // Critical error
  }

  // If not an additional recipient, update BookingDetails
  if (!isAdditionalRecipient && bookingCheck.bookingItem) {
    await updateBookingCertificate(
      ddbClient,
      bookingCheck.bookingItem.BookingID.S
    );
  }

  return true;
}

export const handler = async (event) => {
  console.log(JSON.stringify(event));
  console.log(event);
  const ddbClient = new DynamoDBClient({});
  const s3Client = new S3Client({});
  const sesClient = new SESClient({});
  const bucket = process.env.S3_BUCKET;
  const isTestMode = process.env.TEST_MODE === "true";
  const fontFiles = [
    {
      path: "templates/fonts/merriweather.regular.ttf",
      family: "Merriweather",
    },
    {
      path: "templates/fonts/merriweather.bold.ttf",
      family: "Merriweather",
      weight: "bold",
    },
    { path: "templates/fonts/alex-brush.regular.ttf", family: "Alex Brush" },
  ];

  // Register fonts
  await loadFonts(s3Client, bucket, fontFiles);

  for (const record of event.Records) {
    let body;
    try {
      body = JSON.parse(record.body);
    } catch (err) {
      console.error("Invalid JSON in SQS message body:", err);
      continue;
    }

    const {
      eventId,
      eventName,
      certificateInfo,
      showLogo,
      orgID,
      attendees,
      templateId = "canva_001",
    } = body;

    if (!orgID) {
      console.error("Missing orgID in payload");
      throw new Error("orgID is required");
    }

    let templateMetadata;
    let templateImg;
    let logoImg = null;
    try {
      ({ templateMetadata, templateImg } = await fetchTemplate(
        ddbClient,
        s3Client,
        bucket,
        templateId
      ));
    } catch (err) {
      console.error(`Error fetching template ${templateId}:`, err);
      throw err;
    }

    if (showLogo) {
      logoImg = await fetchLogo(ddbClient, orgID);
    }

    let processedCount = 0;

    for (const attendee of attendees || []) {
      try {
        const processed = await processAttendee(
          ddbClient,
          s3Client,
          sesClient,
          bucket,
          eventId,
          eventName,
          orgID,
          showLogo,
          templateMetadata,
          templateImg,
          logoImg,
          attendee,
          certificateInfo,
          isTestMode
        );
        if (processed) {
          processedCount++;
        }
      } catch (err) {
        console.error(`Error processing attendee ${attendee.email}:`, err);
        // Continue to next attendee
      }
    }

    // Update event-level status and increment certificate issued count if any were processed
    if (processedCount > 0) {
      await updateEventStatus(ddbClient, eventId, processedCount);
    }
  }
};
