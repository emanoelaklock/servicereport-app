-- 0077: conciliação ignora material da RAT com quantidade 0.
-- Quando o técnico lista um material no apontamento e deixa qtd 0 (não usou), o ramo "usado"
-- da view criava uma linha fantasma na conciliação — sem tarefa_materiais (sem tm_id), o admin
-- não conseguia excluir pela tela. Filtrando qtd > 0, essa linha não aparece (some sozinha).
-- Não afeta material orçado/levado: esse vem do ramo "plano" (tarefa_materiais), intacto.
create or replace view public.vw_conciliacao_tarefa as
 WITH plano AS (
         SELECT tarefa_materiais.tarefa_id,
            tarefa_materiais.match_key,
            (array_agg(tarefa_materiais.id ORDER BY tarefa_materiais.id))[1] AS tm_id,
            max(tarefa_materiais.descricao) AS descricao,
            max(tarefa_materiais.codigo_produto) AS codigo_produto,
            (array_agg(tarefa_materiais.produto_id) FILTER (WHERE tarefa_materiais.produto_id IS NOT NULL))[1] AS produto_id,
            max(tarefa_materiais.unidade) AS unidade,
            max(tarefa_materiais.preco_unitario) AS preco_unitario,
            sum(tarefa_materiais.qtd_orcada) AS qtd_orcada,
            sum(tarefa_materiais.qtd_levada) AS qtd_levada,
            bool_or(tarefa_materiais.revisado) AS revisado
           FROM tarefa_materiais
          GROUP BY tarefa_materiais.tarefa_id, tarefa_materiais.match_key
        ), usado AS (
         SELECT r.tarefa_id,
            COALESCE(m.produto_id::text, NULLIF(btrim(lower(m.codigo_produto)), ''::text), btrim(lower(m.descricao))) AS match_key,
            max(m.descricao) AS descricao,
            (array_agg(m.produto_id) FILTER (WHERE m.produto_id IS NOT NULL))[1] AS produto_id,
            max(m.codigo_produto) AS codigo_produto,
            sum(m.quantidade) AS qtd_utilizada
           FROM materiais m
             JOIN rats r ON r.id = m.rat_id
          WHERE m.origem = 'usado'::text AND r.tarefa_id IS NOT NULL AND m.quantidade > 0::numeric
          GROUP BY r.tarefa_id, (COALESCE(m.produto_id::text, NULLIF(btrim(lower(m.codigo_produto)), ''::text), btrim(lower(m.descricao))))
        ), prop AS (
         SELECT t.id AS tarefa_id,
            t.orcamento_id IS NOT NULL OR COALESCE(sum(tm.qtd_orcada), 0::numeric) > 0::numeric AS tem_proposta
           FROM tarefas t
             LEFT JOIN tarefa_materiais tm ON tm.tarefa_id = t.id
          GROUP BY t.id, t.orcamento_id
        )
 SELECT COALESCE(p.tarefa_id, u.tarefa_id) AS tarefa_id,
    p.tm_id,
    COALESCE(p.match_key, u.match_key) AS match_key,
    COALESCE(p.descricao, u.descricao) AS descricao,
    COALESCE(p.codigo_produto, u.codigo_produto) AS codigo_produto,
    COALESCE(p.produto_id, u.produto_id) AS produto_id,
    p.unidade,
    COALESCE(p.preco_unitario, 0::numeric) AS preco_unitario,
    COALESCE(p.qtd_orcada, 0::numeric) AS qtd_orcada,
    COALESCE(p.qtd_levada, 0::numeric) AS qtd_levada,
    ceil(COALESCE(u.qtd_utilizada, 0::numeric)) AS qtd_utilizada,
    COALESCE(p.qtd_levada, 0::numeric) - ceil(COALESCE(u.qtd_utilizada, 0::numeric)) AS qtd_devolvida,
        CASE
            WHEN COALESCE(p.qtd_orcada, 0::numeric) = 0::numeric AND ceil(COALESCE(u.qtd_utilizada, 0::numeric)) > 0::numeric THEN
            CASE
                WHEN COALESCE(pr.tem_proposta, false) THEN 'sem_orcada'::text
                ELSE 'sem_orcamento'::text
            END
            WHEN ceil(COALESCE(u.qtd_utilizada, 0::numeric)) > COALESCE(p.qtd_levada, 0::numeric) THEN 'falta_estoque'::text
            WHEN COALESCE(p.qtd_orcada, 0::numeric) > 0::numeric AND ceil(COALESCE(u.qtd_utilizada, 0::numeric)) > COALESCE(p.qtd_orcada, 0::numeric) THEN 'acima_orcado'::text
            WHEN COALESCE(p.qtd_levada, 0::numeric) > ceil(COALESCE(u.qtd_utilizada, 0::numeric)) THEN 'devolver'::text
            ELSE 'ok'::text
        END AS situacao,
    COALESCE(p.revisado, false) AS revisado,
    COALESCE(u.qtd_utilizada, 0::numeric) AS qtd_utilizada_real
   FROM plano p
     FULL JOIN usado u ON p.tarefa_id = u.tarefa_id AND p.match_key = u.match_key
     LEFT JOIN prop pr ON pr.tarefa_id = COALESCE(p.tarefa_id, u.tarefa_id)
  WHERE app_role() = ANY (ARRAY['admin'::text, 'gestor_axis'::text, 'comercial'::text]);
