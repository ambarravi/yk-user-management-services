const {
  DynamoDBClient,
  UpdateItemCommand,
  GetItemCommand,
  PutItemCommand,
  QueryCommand,
} = require("@aws-sdk/client-dynamodb");
const {
  S3Client,
  GetObjectCommand,
  PutObjectCommand,
} = require("@aws-sdk/client-s3");
const { SESClient, SendRawEmailCommand } = require("@aws-sdk/client-ses");
const { createCanvas, loadImage, registerFont } = require("canvas");
const QRCode = require("qrcode");
const { v4: uuidv4 } = require("uuid"); // Add uuid library

// Utility function to wrap text
const wrapText = (ctx, text, maxWidth, fontSize, fontFamily) => {
  ctx.font = `${fontSize}px ${fontFamily}`;
  const words = text.split(" ");
  const lines = [];
  let currentLine = "";

  for (const word of words) {
    const testLine = currentLine ? `${currentLine} ${word}` : word;
    const metrics = ctx.measureText(testLine);
    const testWidth = metrics.width;

    if (testWidth > maxWidth && currentLine) {
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

// Utility to convert stream to buffer
async function streamToBuffer(stream) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    stream.on("data", (chunk) => chunks.push(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolve(Buffer.concat(chunks)));
  });
}

exports.handler = async (event) => {
  const ddbClient = new DynamoDBClient({});
  const s3Client = new S3Client({});
  const sesClient = new SESClient({});
  const bucket = process.env.S3_BUCKET;
  const fontFiles = [
    {
      path: "templates/fonts/Merriweather-Regular.ttf",
      family: "Merriweather",
    },
    {
      path: "templates/fonts/Merriweather-Bold.ttf",
      family: "Merriweather",
      weight: "bold",
    },
    { path: "templates/fonts/AlexBrush-Regular.ttf", family: "Alex Brush" },
  ];

  // Register fonts
  for (const font of fontFiles) {
    try {
      const fontData = await s3Client.send(
        new GetObjectCommand({ Bucket: bucket, Key: font.path })
      );
      const fontBuffer = await streamToBuffer(fontData.Body);
      registerFont(fontBuffer, { family: font.family, weight: font.weight });
    } catch (err) {
      console.error(`Failed to load font ${font.path}:`, err);
    }
  }

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
      orgId,
      attendees,
      templateId = "canva_001",
    } = body;

    if (!orgId) {
      console.error("Missing orgId in payload");
      throw new Error("orgId is required");
    }

    // Fetch dynamic template metadata from DynamoDB
    let templateMetadata;
    let templateImg;
    try {
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

      templateMetadata = {
        templateId: templateId,
        name: templateResult.Item.TemplateName.S,
        dimensions: {
          width: parseInt(templateResult.Item.Dimensions.M.width.N, 10),
          height: parseInt(templateResult.Item.Dimensions.M.height.N, 10),
        },
        placeholders: templateResult.Item.Placeholders.L.map((p) => ({
          id: p.M.id.S,
          type: p.M.type.S,
          position: {
            x: parseInt(p.M.position.M.x.N, 10),
            y: parseInt(p.M.position.M.y.N, 10),
          },
          style: {
            fontSize: parseInt(p.M.style.M.fontSize.N, 10),
            fontFamily: p.M.style.M.fontFamily.S,
            color: p.M.style.M.color.S,
            align: p.M.style.M.align.S,
            fontWeight: p.M.style.M.fontWeight?.S || "normal",
          },
          maxWidth: parseInt(p.M.maxWidth?.N || "0", 10) || 800,
          lineHeight: parseInt(p.M.lineHeight?.N || "0", 10) || 60,
          size: p.M.size
            ? {
                width: parseInt(p.M.size.M.width.N, 10),
                height: parseInt(p.M.size.M.height.N, 10),
              }
            : undefined,
        })),
      };

      // Load template image dynamically
      const templateKey = templateResult.Item.TemplateS3Key.S;
      const templateData = await s3Client.send(
        new GetObjectCommand({ Bucket: bucket, Key: templateKey })
      );
      const templateBuffer = await streamToBuffer(templateData.Body);
      templateImg = await loadImage(templateBuffer);
    } catch (err) {
      console.error(`Error fetching template ${templateId}:`, err);
      throw err;
    }

    // Fetch logo path from Organizers table
    let logoImg = null;
    let logoPath = null;
    if (showLogo) {
      try {
        const orgParams = {
          TableName: "Organizers",
          Key: { OrganizerID: { S: orgId } },
        };
        const orgResult = await ddbClient.send(new GetItemCommand(orgParams));
        if (!orgResult.Item || !orgResult.Item.logoPath?.S) {
          console.error(`No logoPath found for OrganizerID ${orgId}`);
        } else {
          logoPath = orgResult.Item.logoPath.S;
          logoImg = await loadImage(logoPath);
        }
      } catch (err) {
        console.error(`Error fetching logo for OrganizerID ${orgId}:`, err);
        logoImg = null;
      }
    }

    let processedNewAttendees = false;

    for (const attendee of attendees || []) {
      const { name, email } = attendee;
      if (!name || !email) {
        console.log(`Skipping attendee: missing name or email`);
        continue;
      }

      // Generate UserID from email
      const userId = email.replace(/[^a-zA-Z0-9]/g, "-");

      // Generate unique CertificateID
      const certificateId = uuidv4();

      // Check if certificate already exists in CertificateRecipients
      const checkCertParams = {
        TableName: "CertificateRecipients",
        Key: {
          EventID: { S: eventId },
          AttendeeEmail: { S: email },
        },
      };

      try {
        const checkResult = await ddbClient.send(
          new GetItemCommand(checkCertParams)
        );
        if (
          checkResult.Item &&
          checkResult.Item.CertificateStatus.S === "Generated"
        ) {
          console.log(
            `Certificate already generated for ${email} in event ${eventId}, skipping`
          );
          continue;
        }
      } catch (err) {
        console.error(
          `Error checking CertificateRecipients for ${email}:`,
          err
        );
        continue;
      }

      // Check attendance in BookingDetails
      let isAdditionalRecipient = true;
      let bookingItem = null;
      try {
        const queryParams = {
          TableName: "BookingDetails",
          IndexName: "EventBookingIndex",
          KeyConditionExpression:
            "EventID = :eventId AND BookingEmail = :email",
          ExpressionAttributeValues: {
            ":eventId": { S: eventId },
            ":email": { S: email },
          },
        };
        const queryResult = await ddbClient.send(new QueryCommand(queryParams));

        if (queryResult.Items.length > 0) {
          bookingItem = queryResult.Items[0];
          isAdditionalRecipient = false;
          if (!bookingItem.MarkAttendance.BOOL) {
            console.log(
              `Attendance not marked for ${email} in event ${eventId}, skipping`
            );
            continue;
          }
        } else {
          console.log(
            `No booking found for ${email} in event ${eventId}, processing as additional recipient`
          );
        }
      } catch (err) {
        console.error(`Error querying BookingDetails for ${email}:`, err);
        continue;
      }

      // Proceed with certificate generation
      processedNewAttendees = true;

      // Generate QR code with CertificateID
      const qrCodeUrl = `https://tikties.com/certificate/verify/${certificateId}`;
      const qrDataUrl = await QRCode.toDataURL(qrCodeUrl, { margin: 1 });
      const qrImg = await loadImage(qrDataUrl);

      // Create canvas
      const width = templateMetadata.dimensions.width;
      const height = templateMetadata.dimensions.height;
      const canvas = createCanvas(width, height);
      const ctx = canvas.getContext("2d");

      // Draw background
      ctx.drawImage(templateImg, 0, 0, width, height);

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
        if (placeholder.type === "text") {
          const text = sampleData[placeholder.id] || "";
          const fontWeight = placeholder.style.fontWeight || "normal";
          ctx.font = `${fontWeight} ${placeholder.style.fontSize}px ${placeholder.style.fontFamily}`;
          ctx.fillStyle = placeholder.style.color;
          ctx.textAlign = placeholder.style.align || "left";
          ctx.textBaseline = "top";

          const lines = wrapText(
            ctx,
            text,
            placeholder.maxWidth || width,
            placeholder.style.fontSize,
            placeholder.style.fontFamily
          );

          const lineHeight =
            placeholder.lineHeight || placeholder.style.fontSize * 1.2;
          lines.forEach((line, index) => {
            ctx.fillText(
              line,
              placeholder.position.x,
              placeholder.position.y + index * lineHeight
            );
          });
        } else if (placeholder.type === "qr") {
          ctx.drawImage(
            sampleData.qr_code,
            placeholder.position.x,
            placeholder.position.y,
            placeholder.size.width,
            placeholder.size.height
          );
        } else if (placeholder.type === "image" && sampleData[placeholder.id]) {
          ctx.save();
          ctx.beginPath();
          ctx.arc(
            placeholder.position.x + placeholder.size.width / 2,
            placeholder.position.y + placeholder.size.height / 2,
            placeholder.style.radius,
            0,
            Math.PI * 2
          );
          ctx.clip();
          ctx.drawImage(
            sampleData[placeholder.id],
            placeholder.position.x,
            placeholder.position.y,
            placeholder.size.width,
            placeholder.size.height
          );
          ctx.restore();
        }
      });

      // Get PNG buffer
      const buffer = canvas.toBuffer("image/png");

      // Upload to S3
      const certKey = `${eventId}/${userId}/certificate.png`;
      try {
        await s3Client.send(
          new PutObjectCommand({
            Bucket: bucket,
            Key: certKey,
            Body: buffer,
            ContentType: "image/png",
          })
        );
      } catch (err) {
        console.error(`Error uploading to S3 for ${certKey}:`, err);
        // Store failure status in DynamoDB
        await ddbClient.send(
          new PutItemCommand({
            TableName: "CertificateRecipients",
            Item: {
              EventID: { S: eventId },
              AttendeeEmail: { S: email },
              UserID: { S: userId },
              CertificateID: { S: certificateId }, // Add CertificateID
              CertificateStatus: { S: "Failed" },
              Name: { S: name },
            },
          })
        );
        continue;
      }

      // Send email with attachment
      const fromEmail = "support@tikties.com";
      const subject = "Your Event Certificate";
      const textBody = "Please find your certificate attached.";

      const attachmentBase64 = buffer.toString("base64");
      const rawEmail = `From: ${fromEmail}
To: ${email}
Subject: ${subject}
MIME-Version: 1.0
Content-Type: multipart/mixed; boundary="NextPart"

--NextPart
Content-Type: text/plain

${textBody}

--NextPart
Content-Type: image/png; name="certificate.png"
Content-Transfer-Encoding: base64
Content-Disposition: attachment

${attachmentBase64}
--NextPart--`;

      try {
        await sesClient.send(
          new SendRawEmailCommand({
            RawMessage: { Data: Buffer.from(rawEmail) },
          })
        );
      } catch (err) {
        console.error(`Error sending email to ${email}:`, err);
        // Store failure status in DynamoDB
        await ddbClient.send(
          new PutItemCommand({
            TableName: "CertificateRecipients",
            Item: {
              EventID: { S: eventId },
              AttendeeEmail: { S: email },
              UserID: { S: userId },
              CertificateID: { S: certificateId }, // Add CertificateID
              CertificateStatus: { S: "Failed" },
              CertificateS3Key: { S: certKey },
              Name: { S: name },
            },
          })
        );
        continue;
      }

      // Store certificate details in CertificateRecipients
      try {
        const recordParams = {
          TableName: "CertificateRecipients",
          Item: {
            EventID: { S: eventId },
            AttendeeEmail: { S: email },
            UserID: { S: userId },
            CertificateID: { S: certificateId }, // Add CertificateID
            CertificateStatus: { S: "Generated" },
            CertificateS3Key: { S: certKey },
            Name: { S: name },
            EventName: { S: eventName }, // For verification
            CertificateInfo: { S: certificateInfo }, // For verification
            QRCodeUrl: { S: qrCodeUrl }, // For audit
          },
        };
        await ddbClient.send(new PutItemCommand(recordParams));
      } catch (err) {
        console.error(`Error storing certificate details for ${email}:`, err);
        throw err; // Critical error, send to DLQ
      }

      // If not an additional recipient, update BookingDetails
      if (!isAdditionalRecipient && bookingItem) {
        try {
          const updateBookingParams = {
            TableName: "BookingDetails",
            Key: { BookingID: bookingItem.BookingID },
            UpdateExpression: "SET CertificateIssued = :true",
            ExpressionAttributeValues: { ":true": { BOOL: true } },
          };
          await ddbClient.send(new UpdateItemCommand(updateBookingParams));
        } catch (err) {
          console.error(`Error updating BookingDetails for ${email}:`, err);
          // Continue processing
        }
      }
    }

    // Update event-level status if new attendees were processed
    if (processedNewAttendees) {
      try {
        const updateParams = {
          TableName: process.env.DYNAMODB_EVENT_TABLE,
          Key: { EventID: { S: eventId } },
          UpdateExpression: "SET CertificateStatus = :status",
          ExpressionAttributeValues: { ":status": { S: "Completed" } },
        };
        await ddbClient.send(new UpdateItemCommand(updateParams));
      } catch (err) {
        console.error(`Error updating event status for ${eventId}:`, err);
        throw err;
      }
    }
  }
};
