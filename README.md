# Poker Ledger

A public leaderboard for poker nights. Anyone with the link can see standings, nights and settle-ups.
Only the admin account can sign in and edit.

- `index.html`, `app.js`: the whole site (no build step)
- `config.js`: your Supabase URL and anon key
- `supabase/schema.sql`: tables and the "anyone reads, only admin writes" rules
- `supabase/seed.sql`: your first two nights

Open the site before `config.js` is filled in and it runs in **demo mode** on sample data. Nothing is saved in that mode.

## 1. Supabase (database + admin login)

1. Go to supabase.com, select **New project**, and pick any name, a strong database password and the region nearest you.
2. Open **SQL Editor → New query**, paste all of `supabase/schema.sql` and select **Run**. Then do the same with `supabase/seed.sql`.
3. **Authentication → Users → Add user → Create new user**: enter your email and a password. Tick *Auto confirm user*.
4. Back in **SQL Editor**, make that user the admin (use your own email):
   ```sql
   insert into public.admins (user_id)
   select id from auth.users where email = 'you@example.com';
   ```
5. **Authentication → Sign In / Providers**: turn **off** "Allow new users to sign up". This is optional, because someone who signs up still can't edit, but it keeps strangers from creating accounts.
6. **Project Settings → API** (or the **Connect** button): copy the **Project URL** and the **anon public** key into `config.js`.
   Do **not** use the `service_role` key anywhere.

## 2. GitHub (stores the code)

Without installing anything:
1. github.com → **New repository** → name it `poker-ledger` → **Create**.
2. On the empty repo page, select **uploading an existing file**, drag in everything from this folder
   (`index.html`, `app.js`, `config.js`, `README.md`, `.gitignore` and the `supabase` folder), and select **Commit changes**.

To change the site later, edit the file on GitHub (pencil icon) or upload the new version. Either way it redeploys on its own.

## 3. Vercel (hosts the site)

1. vercel.com → sign up **with GitHub**.
2. **Add New → Project** → import `poker-ledger`.
3. Leave the Framework Preset on **Other** and leave the build settings empty, then select **Deploy**.
4. You get an address like `poker-ledger.vercel.app`. Share it with your friends.
   You can rename it under Project → Settings → Domains.

## 4. Check nobody else can edit

- Open the site in a private window: you should see the standings with an **Admin sign in** button and no edit controls.
- Sign in with your admin email and password, then change something small and change it back.
- To test the database directly, run this in a terminal (fill in your URL and anon key). It tries to add a player without signing in and must fail with `new row violates row-level security policy`:
  ```powershell
  Invoke-RestMethod -Method Post -Uri "https://YOUR-PROJECT.supabase.co/rest/v1/players" -Headers @{apikey="YOUR_ANON_KEY"; Authorization="Bearer YOUR_ANON_KEY"; "Content-Type"="application/json"} -Body '{"id":"test","name":"Hacker"}'
  ```

## Running it on your computer

```bash
python -m http.server 5173
```
Then open http://localhost:5173.
