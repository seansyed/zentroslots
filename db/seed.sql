-- Demo seed: one admin, one staff member with availability, two services.
-- Multi-tenant: everything is attached to the "Default Workspace" tenant.
-- Idempotent: re-runnable. Passwords are bcrypt('demo1234').

DO $$
DECLARE
  v_tenant_id  uuid;
  v_admin_id   uuid;
  v_staff_id   uuid;
  v_service_a  uuid;
  v_service_b  uuid;
BEGIN
  -- Tenant (created by migration 0002; this is a safety insert if seed is run on a fresh DB)
  INSERT INTO tenants (name, slug, plan, active)
  VALUES ('Default Workspace', 'default', 'free', true)
  ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name
  RETURNING id INTO v_tenant_id;

  IF v_tenant_id IS NULL THEN
    SELECT id INTO v_tenant_id FROM tenants WHERE slug = 'default';
  END IF;

  -- Admin
  INSERT INTO users (tenant_id, email, password_hash, role, name, timezone)
  VALUES (
    v_tenant_id,
    'admin@example.com',
    '$2a$10$tPjDvUPZvk5CpZzBA1J01.qW1DFy75ph4wC8si1xGK.WR/oUR0THm',
    'admin', 'Demo Admin', 'America/Los_Angeles'
  )
  ON CONFLICT (tenant_id, email) DO UPDATE SET name = EXCLUDED.name
  RETURNING id INTO v_admin_id;

  -- Staff
  INSERT INTO users (tenant_id, email, password_hash, role, name, timezone)
  VALUES (
    v_tenant_id,
    'staff@example.com',
    '$2a$10$tPjDvUPZvk5CpZzBA1J01.qW1DFy75ph4wC8si1xGK.WR/oUR0THm',
    'staff', 'Jamie Staff', 'America/Los_Angeles'
  )
  ON CONFLICT (tenant_id, email) DO UPDATE SET name = EXCLUDED.name
  RETURNING id INTO v_staff_id;

  -- Weekly availability: Mon-Fri 9am-5pm in staff's tz (America/Los_Angeles)
  DELETE FROM availability WHERE user_id = v_staff_id;
  INSERT INTO availability (tenant_id, user_id, day_of_week, start_time, end_time)
  SELECT v_tenant_id, v_staff_id, d, TIME '09:00', TIME '17:00'
  FROM generate_series(1, 5) AS d;

  -- Services (look up by name within tenant)
  SELECT id INTO v_service_a FROM services
   WHERE tenant_id = v_tenant_id AND name = '30-min Intro Call' LIMIT 1;
  IF v_service_a IS NULL THEN
    INSERT INTO services (tenant_id, name, description, duration_minutes, price, buffer_before, buffer_after)
    VALUES (v_tenant_id, '30-min Intro Call', 'Quick intro chat over Google Meet.', 30, 0, 5, 5)
    RETURNING id INTO v_service_a;
  END IF;

  SELECT id INTO v_service_b FROM services
   WHERE tenant_id = v_tenant_id AND name = '60-min Deep Dive' LIMIT 1;
  IF v_service_b IS NULL THEN
    INSERT INTO services (tenant_id, name, description, duration_minutes, price, buffer_before, buffer_after)
    VALUES (v_tenant_id, '60-min Deep Dive', 'Working session with screen share.', 60, 12500, 10, 10)
    RETURNING id INTO v_service_b;
  END IF;

  -- Link both services to the staff member
  INSERT INTO service_staff (service_id, user_id, tenant_id)
  VALUES (v_service_a, v_staff_id, v_tenant_id)
  ON CONFLICT DO NOTHING;
  INSERT INTO service_staff (service_id, user_id, tenant_id)
  VALUES (v_service_b, v_staff_id, v_tenant_id)
  ON CONFLICT DO NOTHING;
END $$;

\echo ''
\echo 'Seed complete.'
\echo '  Tenant slug: default'
\echo '  Admin login: admin@example.com / demo1234'
\echo '  Staff login: staff@example.com / demo1234'
