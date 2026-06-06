-- Deslocamento: cidade/UF separadas (origem e destino), preenchidas por GPS (geocodificação reversa).
alter table public.deslocamentos
  add column if not exists origem_cidade text,
  add column if not exists origem_uf text,
  add column if not exists destino_cidade text,
  add column if not exists destino_uf text;
