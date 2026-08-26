-- 003_actors.sql — directorio de actores para identidad y roles (Ola 3A).
--
-- Sin passwords por usuario: un passcode compartido vive en server/.env
-- (ACTOR_PASSCODE) y la sesión viaja en una cookie firmada (HMAC). Este
-- directorio solo nombra QUIÉN hace qué; el roster replica los
-- RESPONSABLES del plan demo con roles mezclados.

CREATE TABLE actors (
  id         uuid PRIMARY KEY,
  name       text NOT NULL UNIQUE,
  role       text NOT NULL CHECK (role IN ('editor', 'visor', 'aprobador')),
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Roster demo (ids fijos para que la cookie siga válida entre seeds):
-- aprobador decide CRs y timesheets; editor escribe; visor solo mira.
INSERT INTO actors (id, name, role) VALUES
  ('00000000-0000-4000-8000-0000000000a1', 'Residencia',    'aprobador'),
  ('00000000-0000-4000-8000-0000000000a2', 'Ing. Ríos',     'editor'),
  ('00000000-0000-4000-8000-0000000000a3', 'Mtro. Solís',   'editor'),
  ('00000000-0000-4000-8000-0000000000a4', 'Electricista',  'editor'),
  ('00000000-0000-4000-8000-0000000000a5', 'Topografía',    'visor'),
  ('00000000-0000-4000-8000-0000000000a6', 'Cuadrilla A',   'visor')
ON CONFLICT (id) DO NOTHING;
