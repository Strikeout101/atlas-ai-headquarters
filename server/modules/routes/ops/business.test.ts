import express from "express";
import request from "supertest";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { ensureBusinessSchema, registerBusinessRoutes } from "./business.ts";

const databases: DatabaseSync[] = [];

function harness() {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  ensureBusinessSchema(db);
  ensureBusinessSchema(db);
  const app = express();
  app.use(express.json());
  registerBusinessRoutes(app, db);
  databases.push(db);
  return { app, db };
}

afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});

describe("business records", () => {
  it("keeps tech tickets, rental quotes, and communication drafts within their business", async () => {
    const { app } = harness();
    const tech = await request(app)
      .post("/api/business/contacts")
      .send({ business: "tech", name: "Nia Gray", email: "nia@example.com" })
      .expect(201);
    const rental = await request(app)
      .post("/api/business/contacts")
      .send({ business: "rental", name: "Theo Bell" })
      .expect(201);
    const techId = tech.body.item.id as string;
    const rentalId = rental.body.item.id as string;

    await request(app)
      .post("/api/business/tickets")
      .send({ contact_id: techId, title: "Laptop will not boot", status: "new" })
      .expect(201);
    await request(app)
      .post("/api/business/quotes")
      .send({ contact_id: rentalId, event_name: "Summer gathering", items: "Two tents and chairs", status: "draft" })
      .expect(201);
    await request(app)
      .post("/api/business/drafts")
      .send({
        business: "tech",
        contact_id: techId,
        channel: "email",
        purpose: "follow_up",
        body: "Your repair is ready.",
        status: "draft",
      })
      .expect(201);
    await request(app)
      .post("/api/business/drafts")
      .send({
        business: "rental",
        contact_id: rentalId,
        channel: "sms",
        purpose: "checkout",
        body: "Please confirm the pickup window.",
        status: "ready",
      })
      .expect(201);

    const techContacts = await request(app).get("/api/business/contacts?business=tech").expect(200);
    expect(techContacts.body.items.map((item: { id: string }) => item.id)).toEqual([techId]);
    const techDrafts = await request(app).get("/api/business/drafts?business=tech").expect(200);
    expect(techDrafts.body.items).toHaveLength(1);
    expect(techDrafts.body.items[0]).toMatchObject({ channel: "email", status: "draft" });
    expect((await request(app).get("/api/business/quotes").expect(200)).body.items).toHaveLength(1);
  });

  it("rejects cross-business contact links and invalid statuses", async () => {
    const { app } = harness();
    const rental = await request(app)
      .post("/api/business/contacts")
      .send({ business: "rental", name: "Mira Lee" })
      .expect(201);
    const rentalId = rental.body.item.id as string;
    expect(
      (
        await request(app)
          .post("/api/business/tickets")
          .send({ contact_id: rentalId, title: "Repair", status: "new" })
          .expect(400)
      ).body.error,
    ).toBe("contact_business_mismatch");
    expect(
      (
        await request(app)
          .post("/api/business/drafts")
          .send({
            business: "tech",
            contact_id: rentalId,
            channel: "email",
            purpose: "outreach",
            body: "Hello",
            status: "draft",
          })
          .expect(400)
      ).body.error,
    ).toBe("contact_business_mismatch");
    expect(
      (
        await request(app)
          .post("/api/business/quotes")
          .send({ event_name: "Party", items: "Chairs", status: "paid" })
          .expect(400)
      ).body.error,
    ).toBe("invalid_status");
  });

  it("edits records, archives drafts, and exposes no send or payment action", async () => {
    const { app } = harness();
    const draft = await request(app)
      .post("/api/business/drafts")
      .send({
        business: "rental",
        channel: "social",
        purpose: "promotion",
        body: "Weekend availability",
        status: "draft",
      })
      .expect(201);
    const id = draft.body.item.id as string;
    const updated = await request(app)
      .patch(`/api/business/drafts/${id}`)
      .send({ status: "ready", subject: "Weekend tents" })
      .expect(200);
    expect(updated.body.item).toMatchObject({ status: "ready", subject: "Weekend tents" });
    await request(app).post(`/api/business/drafts/${id}/send`).expect(404);
    await request(app).post("/api/business/payments").expect(404);
    await request(app).delete(`/api/business/drafts/${id}`).expect(200);
    await request(app).get(`/api/business/drafts/${id}`).expect(404);
  });

  it("stores optional empty contact links as null and clears links when a contact is deleted", async () => {
    const { app } = harness();
    const contact = await request(app)
      .post("/api/business/contacts")
      .send({ business: "tech", name: "Tara Cole" })
      .expect(201);
    const ticket = await request(app)
      .post("/api/business/tickets")
      .send({ contact_id: "", title: "Network setup", status: "new" })
      .expect(201);
    expect(ticket.body.item.contact_id).toBeNull();
    const linked = await request(app)
      .patch(`/api/business/tickets/${ticket.body.item.id}`)
      .send({ contact_id: contact.body.item.id })
      .expect(200);
    expect(linked.body.item.contact_id).toBe(contact.body.item.id);
    await request(app).delete(`/api/business/contacts/${contact.body.item.id}`).expect(200);
    const remaining = await request(app).get(`/api/business/tickets/${ticket.body.item.id}`).expect(200);
    expect(remaining.body.item.contact_id).toBeNull();
  });

  it("never lets a draft to a do-not-contact contact be ready, and pulls back ready drafts when a contact opts out", async () => {
    const { app } = harness();
    const contact = await request(app)
      .post("/api/business/contacts")
      .send({ business: "rental", name: "Marisol Okafor" })
      .expect(201);
    const contactId = contact.body.item.id as string;
    expect(contact.body.item.do_not_contact).toBe(0);
    const draft = await request(app)
      .post("/api/business/drafts")
      .send({
        business: "rental",
        contact_id: contactId,
        channel: "email",
        purpose: "promotion",
        body: "Spring deals",
        status: "ready",
      })
      .expect(201);

    const optedOut = await request(app)
      .patch(`/api/business/contacts/${contactId}`)
      .send({ do_not_contact: "1" })
      .expect(200);
    expect(optedOut.body.item.do_not_contact).toBe(1);
    const pulled = await request(app).get(`/api/business/drafts/${draft.body.item.id}`).expect(200);
    expect(pulled.body.item.status).toBe("draft");

    await request(app)
      .patch(`/api/business/drafts/${draft.body.item.id}`)
      .send({ status: "ready" })
      .expect(409, { error: "contact_do_not_contact" });
    await request(app)
      .post("/api/business/drafts")
      .send({
        business: "rental",
        contact_id: contactId,
        channel: "sms",
        purpose: "general",
        body: "Hi",
        status: "ready",
      })
      .expect(409);
    await request(app).patch(`/api/business/contacts/${contactId}`).send({ do_not_contact: "maybe" }).expect(400);

    await request(app).patch(`/api/business/contacts/${contactId}`).send({ do_not_contact: "0" }).expect(200);
    await request(app).patch(`/api/business/drafts/${draft.body.item.id}`).send({ status: "ready" }).expect(200);
  });
});
