-- Llista de la compra COMPARTIDA — configuració de Supabase
-- Executa-ho al teu projecte de Supabase: SQL Editor → New query → enganxa → Run.
-- És idempotent: pots executar-lo tantes vegades com vulguis.
-- Crea UNA sola taula nova (public.shopping_items) i no toca res més.
-- Cap altra taula no apareix enlloc en aquest fitxer.
--
-- Especificació: UNA llista comuna per a TOTS els usuaris registrats.
-- Cal haver iniciat sessió per llegir o escriure; l'anonimat queda bloquejat.

create table if not exists public.shopping_items (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  name text not null check (char_length(name) between 1 and 80),
  qty integer not null default 1 check (qty between 1 and 99),
  cat text not null default 'Other',
  done boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- La columna user_id es conserva només com a auditoria (qui va afegir la fila);
-- l'accés ja NO es filtra per usuari (vegeu polítiques compartides a sota).

create index if not exists shopping_items_user_id_idx
  on public.shopping_items (user_id);

-- Manté updated_at al dia en cada edició.
create or replace function public.shopping_items_touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists shopping_items_touch_updated_at on public.shopping_items;
create trigger shopping_items_touch_updated_at
  before update on public.shopping_items
  for each row execute function public.shopping_items_touch_updated_at();

-- Row Level Security: llista COMPARTIDA — qualsevol usuari autenticat
-- pot llegir i modificar TOTES les files. L'accés anònim queda denegat.
alter table public.shopping_items enable row level security;

-- Neteja les polítiques antigues, tant les per-usuari (v1) com les compartides (v2).
drop policy if exists "shopping_items_select_own" on public.shopping_items;
drop policy if exists "shopping_items_insert_own" on public.shopping_items;
drop policy if exists "shopping_items_update_own" on public.shopping_items;
drop policy if exists "shopping_items_delete_own" on public.shopping_items;
drop policy if exists "shopping_items_shared_select" on public.shopping_items;
drop policy if exists "shopping_items_shared_insert" on public.shopping_items;
drop policy if exists "shopping_items_shared_update" on public.shopping_items;
drop policy if exists "shopping_items_shared_delete" on public.shopping_items;

create policy "shopping_items_shared_select"
  on public.shopping_items for select
  to authenticated
  using (true);

create policy "shopping_items_shared_insert"
  on public.shopping_items for insert
  to authenticated
  with check (true);

create policy "shopping_items_shared_update"
  on public.shopping_items for update
  to authenticated
  using (true)
  with check (true);

create policy "shopping_items_shared_delete"
  on public.shopping_items for delete
  to authenticated
  using (true);

-- Realtime per a la sincronització en directe entre tots els dispositius i usuaris.
-- El bloc DO fa que no falli si la taula ja hi és (evita l'error 42710).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime'
      AND schemaname = 'public'
      AND tablename = 'shopping_items'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.shopping_items;
  END IF;
END
$$;
