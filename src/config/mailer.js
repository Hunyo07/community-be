import nodemailer from 'nodemailer';
import { env } from './env.js';

export const mailer = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: env.mail.user,
    pass: env.mail.appPassword
  },
  tls: {
    rejectUnauthorized: !env.mail.allowSelfSigned
  }
});

export const assertMailerConfigured = () => {
  if (!env.mail.user || !env.mail.appPassword) {
    throw Object.assign(
      new Error('Gmail OTP is not configured. Add GMAIL_USER and GMAIL_APP_PASSWORD to server/.env, then restart the server.'),
      { statusCode: 503 }
    );
  }
};

export const sendOtpEmail = async ({ to, otp }) => {
  assertMailerConfigured();

  try {
    await mailer.sendMail({
      from: `"CommUnity Registration" <${env.mail.user}>`,
      to,
      subject: 'Your CommUnity registration OTP',
      text: `Your CommUnity verification code is ${otp}. It expires in ${env.mail.otpExpiresMinutes} minutes.`,
      html: `
        <div style="font-family:Arial,sans-serif;color:#1F2937">
          <h2 style="color:#174F82">CommUnity email verification</h2>
          <p>Your one-time password is:</p>
          <p style="font-size:28px;font-weight:700;letter-spacing:4px;color:#174F82">${otp}</p>
          <p>This code expires in ${env.mail.otpExpiresMinutes} minutes.</p>
        </div>
      `
    });
  } catch (error) {
    if (error.message?.includes('self-signed certificate')) {
      throw Object.assign(
        new Error('Gmail SMTP certificate is not trusted by Node. For local development, set GMAIL_ALLOW_SELF_SIGNED=true in server/.env and restart the server.'),
        { statusCode: 503 }
      );
    }

    throw error;
  }
};

export const sendPasswordResetOtpEmail = async ({ to, otp }) => {
  assertMailerConfigured();

  try {
    await mailer.sendMail({
      from: `"CommUnity Security" <${env.mail.user}>`,
      to,
      subject: 'Your CommUnity password reset OTP',
      text: `Your CommUnity password reset code is ${otp}. It expires in ${env.mail.otpExpiresMinutes} minutes.`,
      html: `
        <div style="font-family:Arial,sans-serif;color:#1F2937">
          <h2 style="color:#174F82">CommUnity password reset</h2>
          <p>Use this one-time password to reset your account password:</p>
          <p style="font-size:28px;font-weight:700;letter-spacing:4px;color:#174F82">${otp}</p>
          <p>This code expires in ${env.mail.otpExpiresMinutes} minutes.</p>
        </div>
      `
    });
  } catch (error) {
    if (error.message?.includes('self-signed certificate')) {
      throw Object.assign(
        new Error('Gmail SMTP certificate is not trusted by Node. For local development, set GMAIL_ALLOW_SELF_SIGNED=true in server/.env and restart the server.'),
        { statusCode: 503 }
      );
    }

    throw error;
  }
};

export const sendAccountStatusEmail = async ({ to, name, status, reason = '' }) => {
  assertMailerConfigured();

  const approved = status === 'Active' || status === 'Verified';
  const subject = approved ? 'Your CommUnity account has been approved' : 'Your CommUnity account update';
  const message = approved
    ? 'Your resident account has been approved. You can now sign in to CommUnity and submit document requests.'
    : status === 'Rejected'
      ? `Your resident account registration was rejected after document review.${reason ? ` Reason: ${reason}` : ' Please contact your barangay office for assistance.'}`
      : status === 'Needs Correction'
        ? `Your resident account needs correction before approval.${reason ? ` Reason: ${reason}` : ' Please upload a clearer selfie with your valid ID or contact your barangay office.'}`
        : `Your resident account status is now ${status}.${reason ? ` Reason: ${reason}` : ''}`;

  await mailer.sendMail({
    from: `"CommUnity Verification" <${env.mail.user}>`,
    to,
    subject,
    text: `Hello ${name}, ${message}`,
    html: `
      <div style="font-family:Arial,sans-serif;color:#1F2937">
        <h2 style="color:#174F82">CommUnity account verification</h2>
        <p>Hello ${name},</p>
        <p>${message}</p>
      </div>
    `
  });
};
