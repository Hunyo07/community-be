# CommUnity API

Node.js, Express, and MySQL backend for the CommUnity application.

## Setup

1. Install dependencies:

   ```bash
   npm install
   ```

2. Copy `.env.example` to `.env` and update the MySQL credentials.

3. In MySQL Workbench, run `database/schema.sql`.

4. Start the API:

   ```bash
   npm run dev
   ```

## Seeders

Seed sample resident users:

```bash
npm run seed:users
```

Default password for seeded users:

```text
Resident@123
```

Seeded role accounts:

- Admin: `admin@community.test`
- Barangay Staff: `sanisidro.staff@community.test`
- Barangay Staff: `mabini.staff@community.test`
- Barangay Staff: `poblacion.staff@community.test`
- Residents: see `database/seeders/users.sql`   

## Endpoints

- `POST /api/auth/register/request-otp`
- `POST /api/auth/register/verify-otp`
- `POST /api/auth/register`
- `GET /api/dashboard`
- `GET /api/health`
- `GET /api/posts`
- `GET /api/posts/:id`
- `POST /api/posts`
- `PATCH /api/posts/:id`
- `DELETE /api/posts/:id`
- `GET /api/residents`
- `PATCH /api/residents/:id/status`
- `GET /api/services`
- `POST /api/services`

## Realtime Events

Socket.IO runs on the same server as the API.

- `residents:changed`
- `services:changed`
- `dashboard:changed`

## Gmail OTP

Use a Gmail app password, not your regular Gmail password. Set these values in `.env`:

```bash
GMAIL_USER=your_gmail_address@gmail.com
GMAIL_APP_PASSWORD=your_16_character_gmail_app_password
OTP_EXPIRES_MINUTES=10
GMAIL_ALLOW_SELF_SIGNED=false
```

If local Gmail SMTP fails with `self-signed certificate in certificate chain`, your machine or network is likely using a local certificate proxy. For local development only, set:

```bash
GMAIL_ALLOW_SELF_SIGNED=true
```

Then restart the API server. Keep this `false` in production.

Resident registration is resident-only and follows this flow:

1. Resident enters account details.
2. CommUnity sends a Gmail OTP.
3. Resident verifies the OTP.
4. Resident uploads a selfie with valid ID.
5. Account is created as `Pending` for admin review.
