import { Entity, ManyToOne, PrimaryColumn } from "typeorm";
import { MessageRelation } from "./message";

@Entity()
export default class DiscordId {
    @PrimaryColumn("varchar", {length: 18})
    id: string;

    @ManyToOne(() => MessageRelation, m => m.discordIds)
    relation: MessageRelation;
}