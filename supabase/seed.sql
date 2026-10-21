-- Your existing two nights and seven players. Run once after schema.sql.

insert into public.players (id, name, created_at) values
  ('mvhxiq2rkkmof', 'Sai',      1792576088451),
  ('mvhxivhn0tjme', 'Akashtan', 1792576095467),
  ('mvhxixxjcg0jd', 'Vimal',    1792576098631),
  ('mvhxizyngwmbe', 'Yug',      1792576101263),
  ('mvhxj2eap4dq0', 'Sud',      1792576104418),
  ('mvhxj4w441x6g', 'Koch',     1792576107652),
  ('mvhxj8ul4rm59', 'Rohan',    1792576112781)
on conflict (id) do nothing;

insert into public.games (id, date, title, buy_in, created_at, entries) values
  ('mvhxjjdrbvgcs', '2026-10-11', 'yugs', 50, 1792576126431, '{
    "mvhxiq2rkkmof": {"buyIns": [50], "cashOut": 93.5},
    "mvhxixxjcg0jd": {"buyIns": [50], "cashOut": 76.5},
    "mvhxizyngwmbe": {"buyIns": [50], "cashOut": 30},
    "mvhxj2eap4dq0": {"buyIns": [50], "cashOut": 0}
  }'),
  ('mvhxob14bpk3w', '2026-10-18', 'Sais', 50, 1792576348888, '{
    "mvhxiq2rkkmof": {"buyIns": [50], "cashOut": 140.5},
    "mvhxivhn0tjme": {"buyIns": [50, 50], "cashOut": 93.5},
    "mvhxixxjcg0jd": {"buyIns": [50], "cashOut": 0},
    "mvhxizyngwmbe": {"buyIns": [50, 50], "cashOut": 20},
    "mvhxj4w441x6g": {"buyIns": [50], "cashOut": 89},
    "mvhxj8ul4rm59": {"buyIns": [50], "cashOut": 75}
  }')
on conflict (id) do nothing;
